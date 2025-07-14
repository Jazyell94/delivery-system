const cors = require('cors');
const express = require('express');
const http = require('http');
const path = require('path');
const mysql = require('mysql2');
const WebSocket = require('ws');
const bodyParser = require('body-parser');

const app = express();

app.use(cors());

const port = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middlewares
app.use(express.json());
app.use(bodyParser.json());

// Conexão com o banco de dados
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err);
        return;
    }
    console.log('Conectado ao banco de dados MySQL!');
});

// WebSocket
wss.on('connection', (ws) => {
    console.log('Novo cliente WebSocket conectado');

    ws.on('message', (message) => {
        console.log(`Mensagem recebida via WS: ${message}`);
    });

    ws.on('close', () => {
        console.log('Cliente WS desconectado');
    });
});


// ... (código anterior igual)

// ==================== ROTAS DO ADMIN ====================

app.get('/clientes', (req, res) => {
  console.log('Rota /clientes foi chamada');
    const selectedDate = req.query.date || null;

    const query = `
        SELECT c.id AS client_id, c.nome, c.endereco, 
               GROUP_CONCAT(CONCAT(p.produto_id, ' ', p.quantidade, 'x') SEPARATOR ', ') AS produtos,
               SUM(p.quantidade) AS total_quantidade,
               SUM(p.preco * p.quantidade) AS total_preco,
               c.forma_pagamento,
               COALESCE(c.troco, 0) AS troco,
               MAX(c.data_pedido) AS data_pedido,
               COALESCE(c.status, 'pendente') AS status 
        FROM clientes c
        LEFT JOIN produtos_comprados p ON c.id = p.cliente_id
        WHERE (? IS NULL OR DATE(c.data_pedido) = ?)
        GROUP BY c.id
        ORDER BY data_pedido DESC;
    `;

    db.query(query, [selectedDate, selectedDate], (error, results) => {
        if (error) {
            console.error('Erro SQL:', error);
            return res.status(500).json({ error: error.message });
        }

        const formattedResults = results.map(client => {
            try {
                const date = new Date(client.data_pedido);
                client.data_pedido = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')} ${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
                return client;
            } catch (e) {
                return { ...client, data_pedido: "Data inválida" };
            }
        });

        res.json(formattedResults);
    });
});

// ==================== Ajuste importante na finalização de compra ====================

app.post("/finalizar-compra", (req, res) => {
    const { nome, endereco, forma_pagamento, troco, produtos } = req.body;

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ message: "Erro ao iniciar transação" });

        const insertClient = `
            INSERT INTO clientes (nome, endereco, forma_pagamento, troco, data_pedido) 
            VALUES (?, ?, ?, ?, NOW())
        `;

        db.query(insertClient, [nome, endereco, forma_pagamento, troco || null], (err, result) => {
            if (err) {
                return db.rollback(() => {
                    console.error("Erro ao inserir cliente:", err);
                    res.status(500).json({ message: "Erro ao inserir cliente" });
                });
            }

            const clienteId = result.insertId;
            const insertProduct = `
                INSERT INTO produtos_comprados (produto_id, cliente_id, quantidade, preco) 
                VALUES (?, ?, ?, ?)
            `;

            const queries = produtos.map(produto => {
                return new Promise((resolve, reject) => {
                    db.query(insertProduct, [produto.id, clienteId, produto.quantidade, produto.preco], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });

            Promise.all(queries)
                .then(() => {
                    db.commit((err) => {
                        if (err) {
                            return db.rollback(() => {
                                console.error("Erro ao finalizar transação:", err);
                                res.status(500).json({ message: "Erro ao finalizar transação" });
                            });
                        }

                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ action: 'newOrder', data: req.body }));
                            }
                        });

                        res.status(200).json({ message: "Compra finalizada com sucesso!" });
                    });
                })
                .catch(err => {
                    db.rollback(() => {
                        console.error("Erro ao inserir produtos:", err);
                        res.status(500).json({ message: "Erro ao inserir produtos" });
                    });
                });
        });
    });
});


app.post('/pedidos', (req, res) => {
    const { nome, endereco, produtos, total_quantidade, total_preco, forma_pagamento, troco, data_pedido } = req.body;

    const query = 'INSERT INTO pedidos (nome, endereco, produtos, total_quantidade, total_preco, forma_pagamento, troco, data_pedido) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [nome, endereco, produtos, total_quantidade, total_preco, forma_pagamento, troco, data_pedido];

    db.query(query, values, (error, results) => {
        if (error) return res.status(500).json({ error: 'Erro ao criar pedido' });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ action: 'newOrder', data: req.body }));
            }
        });

        res.status(201).json({ message: 'Pedido criado com sucesso' });
    });
});


app.put('/status/:clientId', (req, res) => {
    const clientId = req.params.clientId;
    const { status } = req.body;

    const query = 'UPDATE clientes SET status = ? WHERE id = ?';
    db.query(query, [status, clientId], (error) => {
        if (error) return res.status(500).json({ error: 'Erro ao mudar status' });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ action: 'updateStatus', clientId, status }));
            }
        });

        res.status(200).json({ message: 'Status atualizado com sucesso' });
    });
});


app.put('/edit/:clientId', (req, res) => {
    const clientId = req.params.clientId;
    const { produto_id, quantidade } = req.body;

    const query = 'UPDATE produtos_comprados SET produto_id = ?, quantidade = ? WHERE cliente_id = ?';
    db.query(query, [produto_id, quantidade, clientId], (error) => {
        if (error) return res.status(500).json({ error: 'Erro ao editar pedido' });

        res.sendStatus(200);
    });
});


app.delete('/delete/:clientId', (req, res) => {
    const clientId = req.params.clientId;

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ message: 'Erro ao iniciar transação' });

        const deleteProductsQuery = 'DELETE FROM produtos_comprados WHERE cliente_id = ?';
        db.query(deleteProductsQuery, [clientId], (err) => {
            if (err) return db.rollback(() => res.status(500).json({ message: 'Erro ao excluir produtos' }));

            const deleteClientQuery = 'DELETE FROM clientes WHERE id = ?';
            db.query(deleteClientQuery, [clientId], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ message: 'Erro ao excluir cliente' }));

                db.commit((err) => {
                    if (err) return db.rollback(() => res.status(500).json({ message: 'Erro ao finalizar transação' }));
                    res.status(200).json({ message: 'Cliente e dados relacionados excluídos com sucesso' });
                });
            });
        });
    });
});


app.delete('/clear-database', (req, res) => {
    const clearClientsQuery = 'DELETE FROM clientes';
    const clearOrdersQuery = 'DELETE FROM produtos_comprados';

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: 'Erro ao iniciar a transação' });

        db.query(clearOrdersQuery, (error) => {
            if (error) return db.rollback(() => res.status(500).json({ error: 'Erro ao limpar produtos_comprados' }));

            db.query(clearClientsQuery, (error) => {
                if (error) return db.rollback(() => res.status(500).json({ error: 'Erro ao limpar clientes' }));

                db.commit((err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: 'Erro ao fazer commit da transação' }));

                    console.log('Banco de dados limpo com sucesso');
                    res.sendStatus(204);
                });
            });
        });
    });
});


// ==================== INICIALIZAÇÃO ====================

server.listen(port, () => {
    console.log(`Servidor unificado rodando em http://localhost:${port}`);
    console.log(`WebSocket disponível em ws://localhost:${port}`);
});
