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

// Игровое состояние
const players = new Map();       // { id: { ws, name, color, x, z, rot, hp } }
const zombies = new Map();       // { id: { x, z, type, health, targetId } }
const blocks = new Map();        // { id: { x, y, z, type, hp } }
const droppedItems = new Map();  // { id: { x, z, itemType, count } }

let nextZombieId = 0;
let nextBlockId = 0;
let nextItemId = 0;
let nextPlayerColor = 0;

// Яркие цвета для игроков (чтобы не было двух одинаковых рядом)
const playerColors = [
    0xff4444, // красный
    0x44ff44, // зелёный
    0x4444ff, // синий
    0xffff44, // жёлтый
    0xff44ff, // розовый
    0x44ffff, // голубой
    0xff8844, // оранжевый
    0x8844ff, // фиолетовый
    0xff4488, // розово-красный
    0x88ff44  // салатовый
];

// Типы зомби
const zombieTypes = {
    normal: { color: 0x44aa44, health: 50, speed: 0.03, damage: 10, exp: 10 },
    fat: { color: 0x228822, health: 120, speed: 0.015, damage: 20, exp: 25 },
    fast: { color: 0x88ff88, health: 30, speed: 0.08, damage: 8, exp: 15 },
    explosive: { color: 0xff5555, health: 40, speed: 0.04, damage: 15, exp: 20, explode: true },
    boss: { color: 0xaa00aa, health: 500, speed: 0.02, damage: 30, exp: 100, scale: 1.5 }
};

// Таймер спавна зомби
setInterval(() => {
    if (zombies.size < 30) {
        const types = ['normal', 'fat', 'fast', 'explosive'];
        if (Math.random() < 0.1) types.push('boss');
        const type = types[Math.floor(Math.random() * types.length)];
        
        const angle = Math.random() * Math.PI * 2;
        const dist = 80 + Math.random() * 100;
        
        // Спавним вокруг центра, но не слишком близко к игрокам
        let x = Math.cos(angle) * dist;
        let z = Math.sin(angle) * dist;
        
        // Проверяем, чтобы не заспавнить прямо на игроке
        let tooClose = false;
        players.forEach(p => {
            const dx = p.x - x;
            const dz = p.z - z;
            if (Math.sqrt(dx*dx + dz*dz) < 10) tooClose = true;
        });
        
        if (!tooClose) {
            const zombieId = 'z' + (nextZombieId++);
            zombies.set(zombieId, {
                x, z,
                type,
                health: zombieTypes[type].health,
                maxHealth: zombieTypes[type].health,
                targetId: null,
                lastAttack: 0
            });
            
            broadcast({
                type: 'zombie_spawn',
                id: zombieId,
                x, z,
                type,
                health: zombieTypes[type].health
            });
        }
    }
}, 5000);

// Таймер обновления зомби (движение)
setInterval(() => {
    if (players.size === 0) return;
    
    zombies.forEach((zombie, id) => {
        // Ищем ближайшего игрока
        let closestDist = 1000;
        let closestPlayer = null;
        let closestPlayerId = null;
        
        players.forEach((player, pid) => {
            const dx = player.x - zombie.x;
            const dz = player.z - zombie.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < closestDist) {
                closestDist = dist;
                closestPlayer = player;
                closestPlayerId = pid;
            }
        });
        
        if (closestPlayer) {
            const type = zombieTypes[zombie.type];
            const speed = type.speed;
            
            // Движение к игроку
            const dx = closestPlayer.x - zombie.x;
            const dz = closestPlayer.z - zombie.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            
            if (dist > 2) {
                zombie.x += (dx / dist) * speed;
                zombie.z += (dz / dist) * speed;
            } else {
                // Атака
                const now = Date.now();
                if (now - zombie.lastAttack > 1000) {
                    if (closestPlayer.hp > 0) {
                        closestPlayer.hp -= type.damage;
                        broadcast({
                            type: 'player_hit',
                            id: closestPlayerId,
                            hp: closestPlayer.hp
                        });
                        
                        if (closestPlayer.hp <= 0) {
                            broadcast({
                                type: 'player_death',
                                id: closestPlayerId
                            });
                        }
                    }
                    zombie.lastAttack = now;
                }
            }
            
            // Обновляем позицию зомби для всех
            broadcast({
                type: 'zombie_move',
                id,
                x: zombie.x,
                z: zombie.z
            });
        }
    });
}, 50);

// Очистка отключившихся игроков
setInterval(() => {
    players.forEach((player, id) => {
        if (Date.now() - player.lastSeen > 10000) {
            players.delete(id);
            broadcast({ type: 'player_left', id });
        }
    });
}, 5000);

wss.on('connection', (ws) => {
    const playerId = 'p' + Math.random().toString(36).substring(7);
    const playerColor = playerColors[nextPlayerColor % playerColors.length];
    nextPlayerColor++;
    
    console.log('Игрок подключился:', playerId, 'цвет:', playerColor.toString(16));
    
    // Инициализация игрока
    players.set(playerId, {
        ws,
        name: 'Игрок_' + Math.floor(Math.random() * 1000),
        color: playerColor,
        x: 0,
        z: 0,
        rot: 0,
        hp: 100,
        maxHp: 100,
        level: 1,
        exp: 0,
        lastSeen: Date.now()
    });
    
    // Отправляем новому игроку его данные
    ws.send(JSON.stringify({
        type: 'init',
        id: playerId,
        color: playerColor,
        blocks: Array.from(blocks.entries()).map(([id, block]) => ({ id, ...block })),
        zombies: Array.from(zombies.entries()).map(([id, z]) => ({ id, ...z })),
        items: Array.from(droppedItems.entries()).map(([id, item]) => ({ id, ...item }))
    }));
    
    // Сообщаем всем о новом игроке
    broadcast({
        type: 'player_join',
        id: playerId,
        name: players.get(playerId).name,
        color: playerColor,
        x: 0,
        z: 0,
        rot: 0,
        hp: 100
    }, ws);
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const player = players.get(playerId);
            if (!player) return;
            
            player.lastSeen = Date.now();
            
            switch(msg.type) {
                case 'move':
                    player.x = msg.x;
                    player.z = msg.z;
                    player.rot = msg.rot;
                    
                    broadcast({
                        type: 'player_move',
                        id: playerId,
                        x: msg.x,
                        z: msg.z,
                        rot: msg.rot
                    }, ws);
                    break;
                    
                case 'place_block':
                    // Проверяем, можно ли поставить блок (не на другом блоке)
                    let canPlace = true;
                    const blockX = Math.floor(msg.x / 2) * 2;
                    const blockZ = Math.floor(msg.z / 2) * 2;
                    
                    blocks.forEach(block => {
                        if (Math.abs(block.x - blockX) < 1.5 && Math.abs(block.z - blockZ) < 1.5) {
                            canPlace = false;
                        }
                    });
                    
                    if (canPlace) {
                        const blockId = 'b' + (nextBlockId++);
                        const blockType = msg.blockType || 'wood';
                        
                        blocks.set(blockId, {
                            x: blockX,
                            y: 0.5,
                            z: blockZ,
                            type: blockType,
                            hp: 100
                        });
                        
                        broadcast({
                            type: 'place_block',
                            id: blockId,
                            x: blockX,
                            y: 0.5,
                            z: blockZ,
                            blockType
                        });
                    }
                    break;
                    
                case 'remove_block':
                    if (blocks.has(msg.id)) {
                        // Шанс выпадения ресурса
                        const block = blocks.get(msg.id);
                        if (Math.random() < 0.3) {
                            const itemId = 'i' + (nextItemId++);
                            droppedItems.set(itemId, {
                                x: block.x,
                                z: block.z,
                                itemType: 'wood',
                                count: 1
                            });
                            broadcast({
                                type: 'item_spawn',
                                id: itemId,
                                x: block.x,
                                z: block.z,
                                itemType: 'wood'
                            });
                        }
                        
                        blocks.delete(msg.id);
                        broadcast({
                            type: 'remove_block',
                            id: msg.id
                        });
                    }
                    break;
                    
                case 'zombie_hit':
                    if (zombies.has(msg.id)) {
                        const zombie = zombies.get(msg.id);
                        const type = zombieTypes[zombie.type];
                        
                        zombie.health -= msg.damage;
                        
                        if (zombie.health <= 0) {
                            // Даём опыт игроку
                            player.exp += type.exp;
                            if (player.exp >= player.level * 100) {
                                player.level++;
                                player.exp = 0;
                                player.maxHp += 20;
                                player.hp = player.maxHp;
                                broadcast({
                                    type: 'player_level_up',
                                    id: playerId,
                                    level: player.level,
                                    maxHp: player.maxHp
                                });
                            }
                            
                            zombies.delete(msg.id);
                            broadcast({
                                type: 'zombie_death',
                                id: msg.id,
                                x: zombie.x,
                                z: zombie.z
                            });
                            
                            // Шанс выпадения предмета
                            if (Math.random() < 0.4) {
                                const itemId = 'i' + (nextItemId++);
                                const items = ['wood', 'nails', 'can', 'bandage'];
                                const itemType = items[Math.floor(Math.random() * items.length)];
                                
                                droppedItems.set(itemId, {
                                    x: zombie.x,
                                    z: zombie.z,
                                    itemType,
                                    count: 1
                                });
                                
                                broadcast({
                                    type: 'item_spawn',
                                    id: itemId,
                                    x: zombie.x,
                                    z: zombie.z,
                                    itemType
                                });
                            }
                        } else {
                            broadcast({
                                type: 'zombie_hit',
                                id: msg.id,
                                health: zombie.health
                            });
                        }
                    }
                    break;
                    
                case 'collect_item':
                    if (droppedItems.has(msg.id)) {
                        const item = droppedItems.get(msg.id);
                        droppedItems.delete(msg.id);
                        
                        broadcast({
                            type: 'item_collected',
                            id: msg.id
                        });
                        
                        // Отправляем игроку инвентарь (можно реализовать позже)
                    }
                    break;
                    
                case 'chat':
                    broadcast({
                        type: 'chat',
                        name: player.name,
                        message: msg.message,
                        color: player.color
                    });
                    break;
            }
        } catch(e) {
            console.log('Ошибка обработки сообщения:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('Игрок отключился:', playerId);
        
        // Очищаем все данные игрока
        if (players.has(playerId)) {
            players.delete(playerId);
        }
        
        // Уведомляем всех
        broadcast({
            type: 'player_left',
            id: playerId
        });
    });
});

function broadcast(message, excludeWs = null) {
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🔥 ============================');
    console.log('🔥 IMBOVIY ZOMBIE SURVIVAL');
    console.log('🔥 Сервер запущен на порту', PORT);
    console.log('🔥 ============================');
});
