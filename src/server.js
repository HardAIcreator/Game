const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Игровые комнаты
const rooms = new Map();
const players = new Map();

// Рейтинговая система
const ratings = new Map();

// Начальная расстановка
const initialBoard = [
    ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'],
    ['♟', '♟', '♟', '♟', '♟', '♟', '♟', '♟'],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['♙', '♙', '♙', '♙', '♙', '♙', '♙', '♙'],
    ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖']
];

// Скины на доску
const boardSkins = {
    classic: {
        light: '#f0d9b5',
        dark: '#b58863',
        name: 'Классика'
    },
    wood: {
        light: '#DEB887',
        dark: '#8B4513',
        name: 'Дерево'
    },
    marble: {
        light: '#FFFFFF',
        dark: '#C0C0C0',
        name: 'Мрамор'
    },
    gold: {
        light: '#FFD700',
        dark: '#DAA520',
        name: 'Золото'
    },
    emerald: {
        light: '#50C878',
        dark: '#2E8B57',
        name: 'Изумруд'
    }
};

wss.on('connection', (ws) => {
    const playerId = 'p' + Math.random().toString(36).substring(7);
    const playerName = 'Игрок_' + Math.floor(Math.random() * 1000);
    
    players.set(playerId, {
        id: playerId,
        name: playerName,
        rating: ratings.get(playerId) || 1200,
        ws,
        skin: 'classic'
    });
    
    console.log('🎮 Игрок подключился:', playerName);
    
    // Отправляем список скинов
    ws.send(JSON.stringify({
        type: 'skins_list',
        skins: Object.entries(boardSkins).map(([id, skin]) => ({
            id,
            name: skin.name,
            light: skin.light,
            dark: skin.dark
        }))
    }));
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const player = players.get(playerId);
            
            switch(msg.type) {
                case 'create_room':
                    const roomId = 'room' + Math.random().toString(36).substring(7);
                    rooms.set(roomId, {
                        id: roomId,
                        players: [{
                            id: playerId,
                            name: player.name,
                            rating: player.rating,
                            color: 'white',
                            ready: false
                        }],
                        board: JSON.parse(JSON.stringify(initialBoard)),
                        currentTurn: 'white',
                        gameStarted: false,
                        spectators: [],
                        moves: [],
                        startTime: null
                    });
                    
                    ws.send(JSON.stringify({
                        type: 'room_created',
                        roomId,
                        color: 'white'
                    }));
                    break;
                    
                case 'join_room':
                    const room = rooms.get(msg.roomId);
                    if (room && room.players.length < 2) {
                        room.players.push({
                            id: playerId,
                            name: player.name,
                            rating: player.rating,
                            color: 'black',
                            ready: false
                        });
                        
                        // Уведомляем всех в комнате
                        room.players.forEach(p => {
                            p.ws.send(JSON.stringify({
                                type: 'room_update',
                                players: room.players.map(pl => ({
                                    name: pl.name,
                                    rating: pl.rating,
                                    color: pl.color,
                                    ready: pl.ready
                                }))
                            }));
                        });
                    }
                    break;
                    
                case 'ready':
                    const readyRoom = findPlayerRoom(playerId);
                    if (readyRoom) {
                        const p = readyRoom.players.find(p => p.id === playerId);
                        p.ready = true;
                        
                        // Проверяем, готовы ли оба
                        if (readyRoom.players.length === 2 && 
                            readyRoom.players.every(p => p.ready)) {
                            readyRoom.gameStarted = true;
                            readyRoom.startTime = Date.now();
                            
                            readyRoom.players.forEach(p => {
                                p.ws.send(JSON.stringify({
                                    type: 'game_start',
                                    board: readyRoom.board,
                                    yourColor: p.color,
                                    currentTurn: 'white',
                                    opponent: readyRoom.players.find(op => op.id !== p.id).name
                                }));
                            });
                        } else {
                            readyRoom.players.forEach(p => {
                                p.ws.send(JSON.stringify({
                                    type: 'room_update',
                                    players: readyRoom.players.map(pl => ({
                                        name: pl.name,
                                        rating: pl.rating,
                                        color: pl.color,
                                        ready: pl.ready
                                    }))
                                }));
                            });
                        }
                    }
                    break;
                    
                case 'move':
                    const moveRoom = findPlayerRoom(playerId);
                    if (moveRoom && moveRoom.gameStarted) {
                        const player = moveRoom.players.find(p => p.id === playerId);
                        
                        if (player.color !== moveRoom.currentTurn) {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: '⏳ Сейчас не твой ход!'
                            }));
                            return;
                        }
                        
                        // Проверяем валидность хода (упрощённо)
                        if (isValidMove(moveRoom.board, msg.from, msg.to, player.color)) {
                            // Делаем ход
                            moveRoom.board[msg.to.y][msg.to.x] = moveRoom.board[msg.from.y][msg.from.x];
                            moveRoom.board[msg.from.y][msg.from.x] = '';
                            
                            moveRoom.moves.push({
                                from: msg.from,
                                to: msg.to,
                                player: player.color,
                                time: Date.now() - moveRoom.startTime
                            });
                            
                            // Проверка на мат
                            const checkStatus = checkGameStatus(moveRoom.board, moveRoom.currentTurn === 'white' ? 'black' : 'white');
                            
                            if (checkStatus === 'checkmate') {
                                const winner = player.color;
                                const loser = winner === 'white' ? 'black' : 'white';
                                
                                // Обновляем рейтинг
                                const winnerRating = moveRoom.players.find(p => p.color === winner).rating;
                                const loserRating = moveRoom.players.find(p => p.color === loser).rating;
                                
                                const newRatings = calculateRating(winnerRating, loserRating);
                                
                                moveRoom.players.forEach(p => {
                                    if (p.color === winner) {
                                        ratings.set(p.id, newRatings.winner);
                                    } else {
                                        ratings.set(p.id, newRatings.loser);
                                    }
                                    
                                    p.ws.send(JSON.stringify({
                                        type: 'game_over',
                                        winner,
                                        reason: 'checkmate',
                                        newRating: p.color === winner ? newRatings.winner : newRatings.loser
                                    }));
                                });
                                
                                rooms.delete(moveRoom.id);
                            } else {
                                // Меняем ход
                                moveRoom.currentTurn = moveRoom.currentTurn === 'white' ? 'black' : 'white';
                                
                                // Отправляем всем
                                moveRoom.players.forEach(p => {
                                    p.ws.send(JSON.stringify({
                                        type: 'move',
                                        board: moveRoom.board,
                                        currentTurn: moveRoom.currentTurn,
                                        lastMove: {
                                            from: msg.from,
                                            to: msg.to
                                        },
                                        check: checkStatus === 'check'
                                    }));
                                });
                            }
                        } else {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: '❌ Невозможный ход!'
                            }));
                        }
                    }
                    break;
                    
                case 'set_skin':
                    player.skin = msg.skin;
                    ws.send(JSON.stringify({
                        type: 'skin_applied',
                        skin: msg.skin
                    }));
                    break;
                    
                case 'chat':
                    const chatRoom = findPlayerRoom(playerId);
                    if (chatRoom) {
                        chatRoom.players.forEach(p => {
                            p.ws.send(JSON.stringify({
                                type: 'chat',
                                message: msg.message,
                                sender: player.name,
                                time: new Date().toLocaleTimeString()
                            }));
                        });
                    }
                    break;
                    
                case 'resign':
                    const resignRoom = findPlayerRoom(playerId);
                    if (resignRoom && resignRoom.gameStarted) {
                        const resigner = resignRoom.players.find(p => p.id === playerId);
                        const winner = resigner.color === 'white' ? 'black' : 'white';
                        
                        resignRoom.players.forEach(p => {
                            p.ws.send(JSON.stringify({
                                type: 'game_over',
                                winner,
                                reason: 'resign'
                            }));
                        });
                        
                        rooms.delete(resignRoom.id);
                    }
                    break;
                    
                case 'offer_draw':
                    const drawRoom = findPlayerRoom(playerId);
                    if (drawRoom) {
                        const opponent = drawRoom.players.find(p => p.id !== playerId);
                        opponent.ws.send(JSON.stringify({
                            type: 'draw_offer',
                            from: player.name
                        }));
                    }
                    break;
                    
                case 'accept_draw':
                    const acceptRoom = findPlayerRoom(playerId);
                    if (acceptRoom) {
                        acceptRoom.players.forEach(p => {
                            p.ws.send(JSON.stringify({
                                type: 'game_over',
                                reason: 'draw'
                            }));
                        });
                        rooms.delete(acceptRoom.id);
                    }
                    break;
            }
        } catch(e) {
            console.log('Ошибка:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('❌ Игрок отключился:', playerName);
        
        // Удаляем из комнат
        rooms.forEach((room, roomId) => {
            const playerIndex = room.players.findIndex(p => p.id === playerId);
            if (playerIndex !== -1) {
                const disconnectedPlayer = room.players[playerIndex];
                
                // Уведомляем второго игрока
                room.players.forEach(p => {
                    if (p.id !== playerId) {
                        p.ws.send(JSON.stringify({
                            type: 'opponent_left',
                            name: disconnectedPlayer.name
                        }));
                    }
                });
                
                room.players.splice(playerIndex, 1);
                if (room.players.length === 0) {
                    rooms.delete(roomId);
                }
            }
        });
        
        players.delete(playerId);
    });
});

function findPlayerRoom(playerId) {
    let result = null;
    rooms.forEach(room => {
        if (room.players.some(p => p.id === playerId)) {
            result = room;
        }
    });
    return result;
}

// Упрощённая проверка ходов (для демо)
function isValidMove(board, from, to, color) {
    const piece = board[from.y][from.x];
    const target = board[to.y][to.x];
    
    // Нельзя есть свои фигуры
    if (target && ((color === 'white' && target.charCodeAt(0) < 9812) ||
                   (color === 'black' && target.charCodeAt(0) > 9812))) {
        return false;
    }
    
    return true;
}

function checkGameStatus(board, turn) {
    // Упрощённо - всегда false для демо
    return 'none';
}

function calculateRating(winnerRating, loserRating) {
    const k = 32;
    const expectedWinner = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    
    const newWinner = Math.round(winnerRating + k * (1 - expectedWinner));
    const newLoser = Math.round(loserRating + k * (0 - (1 - expectedWinner)));
    
    return { winner: newWinner, loser: newLoser };
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('♟️ ============================');
    console.log('♟️ ИМБОВЫЕ ШАХМАТЫ ЗАПУЩЕНЫ');
    console.log('♟️ Порт:', PORT);
    console.log('♟️ ============================');
});
