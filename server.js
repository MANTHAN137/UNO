const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- Constants & Config ---
const COLORS = ['red', 'blue', 'green', 'yellow'];
const SPECIAL_VALUES = ['skip', 'reverse', 'draw2'];

// --- Game State Management ---
const games = new Map();

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

class UnoGame {
    constructor(roomCode, hostId) {
        this.roomCode = roomCode;
        this.hostId = hostId;
        this.players = [];
        this.deck = [];
        this.discardPile = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.activeColor = null;
        this.gameState = 'lobby';
        this.previousActiveColor = null;
        this.pendingWildDraw4 = null;
        this.pendingDrawCard = null;
    }

    addPlayer(id, name) {
        if (this.gameState !== 'lobby') return { error: "Game already started" };
        if (this.players.length >= 10) return { error: "Room full" };
        this.players.push({
            id,
            name,
            hand: [],
            saidUno: false,
        });
        return { success: true };
    }

    removePlayer(id) {
        this.players = this.players.filter(p => p.id !== id);
        if (this.players.length === 0) {
            games.delete(this.roomCode);
        } else if (this.hostId === id && this.players.length > 0) {
            this.hostId = this.players[0].id;
        }
    }

    createDeck() {
        let d = [];
        COLORS.forEach(color => {
            d.push({ color, value: '0', type: 'number' });
            for (let i = 1; i <= 9; i++) {
                d.push({ color, value: i.toString(), type: 'number' });
                d.push({ color, value: i.toString(), type: 'number' });
            }
            SPECIAL_VALUES.forEach(val => {
                d.push({ color, value: val, type: 'action' });
                d.push({ color, value: val, type: 'action' });
            });
        });
        for (let i = 0; i < 4; i++) {
            d.push({ color: 'black', value: 'wild', type: 'wild' });
            d.push({ color: 'black', value: 'wild_draw4', type: 'wild' });
        }
        return this.shuffle(d);
    }

    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    refillDeck() {
        if (this.discardPile.length > 1) {
            const top = this.discardPile.pop();
            this.deck = this.shuffle(this.discardPile);
            this.discardPile = [top];
        } else {
            // Rare edge case: Deck empty, discard empty.
        }
    }

    drawCards(count) {
        let drawn = [];
        for (let i = 0; i < count; i++) {
            if (this.deck.length === 0) this.refillDeck();
            if (this.deck.length > 0) drawn.push(this.deck.pop());
        }
        return drawn;
    }

    start() {
        if (this.players.length < 2) return false;
        this.deck = this.createDeck();
        this.players.forEach(p => {
            p.hand = this.drawCards(7);
            p.saidUno = false;
        });

        let firstCard = this.drawCards(1)[0];
        while (firstCard.type === 'wild' && firstCard.value === 'wild_draw4') {
            this.deck.push(firstCard);
            this.deck = this.shuffle(this.deck);
            firstCard = this.drawCards(1)[0];
        }
        this.discardPile = [firstCard];
        this.gameState = 'playing';
        this.activeColor = firstCard.color === 'black' ? null : firstCard.color;

        if (firstCard.value === 'reverse') {
            if (this.players.length === 2) this.turnIndex = 1;
            else {
                this.direction *= -1;
                this.turnIndex = this.players.length - 1;
            }
        } else if (firstCard.value === 'skip') {
            this.turnIndex = 1;
        } else if (firstCard.value === 'draw2') {
            this.players[0].hand.push(...this.drawCards(2));
            this.turnIndex = 1;
        }

        // Logic for first turn if Wild
        if (firstCard.type === 'wild' && !this.activeColor) {
            // We need to force P0 to choose color if index 0 is first player
            // Actually, simplest is default Red for start to avoid UI block
            this.activeColor = 'red';
        }

        return true;
    }

    nextPlayer(steps = 1) {
        let idx = this.turnIndex + (this.direction * steps);
        idx = idx % this.players.length;
        if (idx < 0) idx += this.players.length;
        this.turnIndex = idx;
    }

    getCurrentPlayer() {
        return this.players[this.turnIndex];
    }
}

// --- Socket Logic ---

io.on('connection', (socket) => {
    let currentRoom = null;
    let userId = socket.id;

    socket.on('createGame', ({ paramName }) => {
        const roomCode = generateRoomCode();
        const game = new UnoGame(roomCode, userId);
        const name = paramName || `Player 1`;
        game.addPlayer(userId, name);
        games.set(roomCode, game);
        currentRoom = roomCode;
        socket.join(roomCode);
        socket.emit('gameCreated', { roomCode, isHost: true });
        io.to(roomCode).emit('playerList', game.players);
    });

    socket.on('joinGame', ({ roomCode, paramName }) => {
        if (!roomCode) return;
        const game = games.get(roomCode.toUpperCase());
        if (!game) {
            socket.emit('errorMsg', "Invalid Room Code");
            return;
        }
        const name = paramName || `Player ${game.players.length + 1}`;
        const res = game.addPlayer(userId, name);
        if (res.error) {
            socket.emit('errorMsg', res.error);
            return;
        }
        currentRoom = roomCode.toUpperCase();
        socket.join(currentRoom);
        socket.emit('joinedGame', { roomCode: currentRoom, isHost: game.hostId === userId });
        io.to(currentRoom).emit('playerList', game.players);
    });

    socket.on('startGame', () => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game || game.hostId !== userId) return;

        if (game.start()) {
            io.to(currentRoom).emit('gameStarted', getGameState(game));
            updateGameAll(game);
        } else {
            socket.emit('errorMsg', "Not enough players! Need at least 2.");
        }
    });

    socket.on('playCard', ({ cardIndex, chosenColor }) => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game) return;

        if (game.getCurrentPlayer().id !== userId) return;
        if (game.pendingWildDraw4) return;
        if (game.pendingDrawCard) return;

        const player = game.players[game.turnIndex];
        const card = player.hand[cardIndex];
        const topCard = game.discardPile[game.discardPile.length - 1];

        // Validation
        let isValid = false;
        let isWild = card.type === 'wild';

        if (isWild) isValid = true;
        else {
            let currentColor = game.activeColor || topCard.color;
            if (card.color === currentColor || card.value === topCard.value) isValid = true;
        }

        if (!isValid) return;

        player.hand.splice(cardIndex, 1);
        game.discardPile.push(card);
        game.previousActiveColor = game.activeColor || topCard.color;

        if (isWild) {
            game.activeColor = chosenColor;
        } else {
            game.activeColor = card.color;
        }

        let nextStep = 1;

        if (card.value === 'wild_draw4') {
            let nextPIdx = (game.turnIndex + game.direction) % game.players.length;
            if (nextPIdx < 0) nextPIdx += game.players.length;

            game.pendingWildDraw4 = {
                attackerIdx: game.turnIndex,
                victimIdx: nextPIdx,
                prevColor: game.previousActiveColor
            };

            let victim = game.players[nextPIdx];
            io.to(victim.id).emit('challengePrompt', { attackerName: player.name });
            io.to(currentRoom).emit('gameState', getGameState(game));
            return;
        }
        else if (card.value === 'draw2') {
            let nextPIdx = (game.turnIndex + game.direction) % game.players.length;
            if (nextPIdx < 0) nextPIdx += game.players.length;
            game.players[nextPIdx].hand.push(...game.drawCards(2));
            nextStep = 2;
        }
        else if (card.value === 'skip') {
            nextStep = 2;
        }
        else if (card.value === 'reverse') {
            if (game.players.length === 2) nextStep = 2;
            else game.direction *= -1;
        }

        finishTurn(game, player, nextStep);
    });

    socket.on('respondChallenge', ({ challenge }) => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game || !game.pendingWildDraw4) return;

        if (game.players[game.pendingWildDraw4.victimIdx].id !== userId) return;

        const { attackerIdx, victimIdx, prevColor } = game.pendingWildDraw4;
        const attacker = game.players[attackerIdx];
        const victim = game.players[victimIdx];

        game.pendingWildDraw4 = null; // Clear state first

        if (challenge) {
            let hasColor = attacker.hand.some(c => c.color === prevColor);
            if (hasColor) {
                // Succeeded: Attacker draws 4, Victim turns safely
                attacker.hand.push(...game.drawCards(4));
                io.to(currentRoom).emit('actionLog', { msg: `Challenge WON! ${attacker.name} draws 4.` });
                game.turnIndex = victimIdx;
            } else {
                // Failed: Victim draws 6
                victim.hand.push(...game.drawCards(6));
                io.to(currentRoom).emit('actionLog', { msg: `Challenge LOST! ${victim.name} draws 6.` });

                // WIN Check: Attacker wasn't caught, they might have won
                if (attacker.hand.length === 0) {
                    io.to(game.roomCode).emit('gameOver', { winner: attacker.name });
                    game.gameState = 'ended';
                    return;
                }
                game.nextPlayer(2);
            }
        } else {
            // No Challenge: Victim draws 4
            victim.hand.push(...game.drawCards(4));

            // WIN Check: Attacker wasn't challenged, they might have won
            if (attacker.hand.length === 0) {
                io.to(game.roomCode).emit('gameOver', { winner: attacker.name });
                game.gameState = 'ended';
                return;
            }
            game.nextPlayer(2);
        }

        updateGameAll(game);
    });

    socket.on('drawCard', () => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game) return;
        if (game.getCurrentPlayer().id !== userId) return;
        if (game.pendingDrawCard || game.pendingWildDraw4) return;

        const newCard = game.drawCards(1)[0];
        game.getCurrentPlayer().hand.push(newCard);

        const top = game.discardPile[game.discardPile.length - 1];
        let canPlay = false;
        let c = newCard;
        let activeC = game.activeColor || top.color;
        if (c.type === 'wild' || c.color === activeC || c.value === top.value) {
            canPlay = true;
        }

        if (canPlay) {
            game.pendingDrawCard = { index: game.getCurrentPlayer().hand.length - 1 };
            socket.emit('drawChoice', { card: newCard });
            // Don't finish turn yet
            updateGameAll(game);
        } else {
            finishTurn(game, game.getCurrentPlayer(), 1);
        }
    });

    socket.on('finishDrawTurn', ({ play, chosenColor }) => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game || !game.pendingDrawCard) return;
        if (game.getCurrentPlayer().id !== userId) return;

        if (play) {
            let idx = game.pendingDrawCard.index;
            let player = game.getCurrentPlayer();
            let card = player.hand[idx];

            player.hand.splice(idx, 1);
            game.discardPile.push(card);

            if (card.type === 'wild') {
                game.activeColor = chosenColor || 'red';
            } else {
                game.activeColor = card.color;
            }

            let nextStep = 1;
            // Immediate Effect Application for Played Drawn Card
            if (card.value === 'draw2') {
                let nextPIdx = (game.turnIndex + game.direction) % game.players.length;
                if (nextPIdx < 0) nextPIdx += game.players.length;
                game.players[nextPIdx].hand.push(...game.drawCards(2));
                nextStep = 2;
            } else if (card.value === 'wild_draw4') {
                // Simplified: Applied immediately without challenge for drawn cards to keep flow fast
                let nextPIdx = (game.turnIndex + game.direction) % game.players.length;
                if (nextPIdx < 0) nextPIdx += game.players.length;
                game.players[nextPIdx].hand.push(...game.drawCards(4));
                nextStep = 2;
            } else if (card.value === 'skip') {
                nextStep = 2;
            } else if (card.value === 'reverse') {
                if (game.players.length === 2) nextStep = 2;
                else game.direction *= -1;
            }

            finishTurn(game, player, nextStep);
        } else {
            finishTurn(game, game.getCurrentPlayer(), 1);
        }
        game.pendingDrawCard = null;
    });

    socket.on('sayUno', () => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game) return;
        let p = game.players.find(pl => pl.id === userId);
        if (p) {
            p.saidUno = true;
            io.to(currentRoom).emit('actionLog', { msg: `${p.name} shouted UNO!` });
            updateGameAll(game);
        }
    });

    socket.on('catchUno', () => {
        if (!currentRoom) return;
        const game = games.get(currentRoom);
        if (!game) return;

        let caught = false;
        game.players.forEach(p => {
            if (p.hand.length === 1 && !p.saidUno) {
                p.hand.push(...game.drawCards(2));
                io.to(currentRoom).emit('actionLog', { msg: `${p.name} CAUGHT! (+2 cards)` });
                caught = true;
                p.saidUno = true;
            }
        });
        if (caught) updateGameAll(game);
    });

    socket.on('disconnect', () => {
        if (currentRoom) {
            const game = games.get(currentRoom);
            if (game) {
                game.removePlayer(userId);
                io.to(currentRoom).emit('playerList', game.players);
                if (game.players.length < 2 && game.gameState === 'playing') {
                    game.gameState = 'ended';
                    io.to(currentRoom).emit('errorMsg', "Player disconnected. Game Ended.");
                }
            }
        }
    });
});

function finishTurn(game, player, steps) {
    if (player.hand.length === 0) {
        io.to(game.roomCode).emit('gameOver', { winner: player.name });
        game.gameState = 'ended';
        return;
    }
    if (player.hand.length > 1) player.saidUno = false;
    game.nextPlayer(steps);
    updateGameAll(game);
}

function updateGameAll(game) {
    const state = getGameState(game);
    io.to(game.roomCode).emit('gameState', state);
    game.players.forEach(p => {
        io.to(p.id).emit('handUpdate', p.hand);
    });
}

function getGameState(game) {
    if (!game.players[game.turnIndex]) return {};
    return {
        roomCode: game.roomCode,
        topCard: game.discardPile[game.discardPile.length - 1],
        activeColor: game.activeColor,
        currentPlayer: game.players[game.turnIndex].id,
        direction: game.direction,
        players: game.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand.length,
            isTurn: p.id === game.players[game.turnIndex].id,
            saidUno: p.saidUno
        })),
        pendingDraw: game.pendingDrawCard !== null && game.players[game.turnIndex].id === game.hostId ? false : false // Helper
    };
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`UNO Server running on port ${PORT}`);
});
