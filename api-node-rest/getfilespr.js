const express = require('express');
const axios = require('axios');
const sql = require('mssql');
const app = express();
const port = 7000;// No backend/app.js
const hostname = '192.168.0.21'
const cors = require('cors');
require('dotenv').config();

// Configuração segura do CORS (ambientes de dev e produção)
const corsOptions = {
    origin: '*', // Aceita todas as origens
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions)); // 👈 Use as opções configuradas
// Configurações do SQL Server
const config = {
    user: process.env.user,
    password: process.env.password,
    server: process.env.server,
    database: process.env.database, 
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

// Configurações do GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const FILE_EXTENSIONS = ['.prw', '.tlpp','.trp','.prx'];

// Middleware
app.use(express.json());

// Pool de conexão SQL
const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// Funções auxiliares

// Delay helper
const delay = ms => new Promise(res => setTimeout(res, ms));

// Consulta o rate limit atual da GitHub API
async function getRateLimit() {
    const resp = await axios.get('https://api.github.com/rate_limit', {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
    });
    return resp.data.resources.core.remaining;
}

async function getMergedPRsByDate(date) {
    const url = `https://api.github.com/search/issues?q=repo:${REPO_OWNER}/${REPO_NAME}+is:pr+merged:${date}..${date}`;
    const response = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    await delay(200);
    return response.data.items;
}

async function getTodayMergedPRs() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const url = `https://api.github.com/search/issues?q=repo:${REPO_OWNER}/${REPO_NAME}+is:pr+merged:${today}..${today}`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        return response.data.items;
    } catch (error) {
        console.error('Erro ao buscar PRs:', error.message);
        throw error;
    }
}

async function getPRFiles(prNumber) {
    try {
        const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${prNumber}/files`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        return response.data;
    } catch (error) {
        console.error(`Erro ao buscar arquivos do PR ${prNumber}:`, error.message);
        throw error;
    }
}

// Rotas
app.get('/merged-prs-files', async (req, res) => {
    try {
        await poolConnect;
        const prs = await getTodayMergedPRs();

        for (const pr of prs) {
            const files = await getPRFiles(pr.number);

            const filtered = files.filter(f =>
                FILE_EXTENSIONS.some(ext => f.filename.toLowerCase().endsWith(ext))
            );

            for (const file of filtered) {
                // Verifica se já existe a combinação recurso + pr
                const checkResult = await pool.request()
                    .input('recurso', sql.NVarChar(500), file.filename)
                    .input('pr', sql.Int, pr.number)
                    .query(`
                        SELECT TOP 1 id 
                        FROM Recursos 
                        WHERE recurso = @recurso AND pr = @pr
                    `);

                if (checkResult.recordset.length === 0) {
                    await pool.request()
                        .input('recurso', sql.NVarChar(500), file.filename)
                        .input('usuario', sql.NVarChar(255), pr.user?.login || 'Desconhecido')
                        .input('pr', sql.Int, pr.number)
                        .input('mergeado', sql.DateTime, pr.pull_request.merged_at)
                        .query(`
                            INSERT INTO Recursos 
                            (recurso, observacao, ambiente, usuario, pr, criado, atualizado, mergeado, integrado)
                            VALUES 
                            (@recurso, '', 'Produção / Schedule', @usuario, @pr, 
                            CONVERT(date, GETDATE()), CONVERT(date, GETDATE()), @mergeado, 0)
                        `);
                }
            }
        }

        res.json({
            success: true,
            message: "Dados processados sem duplicidades"
        });

    } catch (error) {
        console.error('Erro:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error instanceof sql.RequestError ? 'Duplicidade violada' : null
        });
    }
});

app.put('/toggle-status/:id', async (req, res) => {
    try {
        await poolConnect;
        const result = await pool.request()
            .input('id', sql.Int, req.params.id)
            .query(`
                UPDATE Recursos 
                SET integrado = ~integrado,
                    atualizado = CONVERT(date, GETDATE())
                WHERE id = @id
            `);

        res.json({
            success: result.rowsAffected[0] > 0,
            rowsAffected: result.rowsAffected[0]
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/recursos', async (req, res) => {
    console.log('🔎 Buscando recursos...');
    try {
        await poolConnect;
        const integrado = req.query.integrado === 'true' ? 1 : 0;

        const result = await pool.request()
            .query(`SELECT * FROM Recursos WHERE integrado = ${integrado}`);

        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.get('/recursos-info', async (req, res) => {
    console.log('🔎 Buscando recursos info...');
    try {
        await poolConnect;
        
        // Validação dos parâmetros
        const fonte = req.query.fonte.toUpperCase();
        console.log(fonte);
        if (!fonte) {
            return res.status(400).json({
                success: false,
                error: 'Parâmetro "fonte" é obrigatório'
            });
        }

        // Query segura usando parameterized query
        const query = `
        SELECT *
        FROM (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY ambiente_rpo, fonte_rpo ORDER BY data_atualizacao DESC) AS rn
            FROM integrations..FONTES_RPO
        ) AS sub
        WHERE rn = 1 and fonte_rpo = @fonte order by ambiente_rpo asc ;
        `;

        const result = await pool.request()
            .input('fonte', sql.VarChar, fonte)
            .query(query);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Nenhum recurso encontrado'
            });
        }

        res.json({
            success: true,
            data: result.recordset
        });

    } catch (error) {
        console.error('Erro na busca:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno no servidor'
        });
    }
});

// Iniciar servidor
app.listen(port, hostname, async () => {
    try {
        await poolConnect;
        console.log(`Servidor rodando em http://${hostname}:${port}`);
        console.log('Conexão com SQL Server estabelecida com sucesso');
    } catch (err) {
        console.error('Erro ao conectar ao SQL Server:', err);
        process.exit(1);
    }
});

app.put('/update-resource/:id', async (req, res) => {
    try {
        await poolConnect;
        const { id } = req.params;
        const { ambiente, observacao } = req.body;

        const request = pool.request().input('id', sql.Int, id);

        let query = 'UPDATE Recursos SET ';
        const updates = [];

        if (ambiente !== undefined) {
            request.input('ambiente', sql.NVarChar(100), ambiente);
            updates.push('ambiente = @ambiente');
        }

        if (observacao !== undefined) {
            request.input('observacao', sql.NVarChar(1000), observacao);
            updates.push('observacao = @observacao');
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'Nada para atualizar' });
        }

        query += updates.join(', ') + ', atualizado = CONVERT(date, GETDATE()) WHERE id = @id';

        const result = await request.query(query);

        res.json({
            success: result.rowsAffected[0] > 0,
            updated: updates.map(f => f.split('=')[0].trim())
        });

    } catch (error) {
        console.error('Erro ao atualizar recurso:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/recursos', async (req, res) => {
    try {
        await poolConnect;
        const { recurso, ambiente, observacao, usuario, pr, mergeado } = req.body;

        if (!recurso || !usuario) {
            return res.status(400).json({ success: false, error: 'Campos obrigatórios ausentes' });
        }

        await pool.request()
            .input('recurso', sql.NVarChar(500), recurso)
            .input('ambiente', sql.NVarChar(100), ambiente || 'Produção')
            .input('observacao', sql.NVarChar(1000), observacao || '')
            .input('usuario', sql.NVarChar(255), usuario)
            .input('pr', sql.Int, pr)
            .input('mergeado', sql.DateTime, mergeado ? new Date(mergeado) : new Date())
            .query(`
                INSERT INTO Recursos 
                (recurso, observacao, ambiente, usuario, pr, criado, atualizado, mergeado, integrado)
                VALUES 
                (@recurso, @observacao, @ambiente, @usuario, @pr, 
                CONVERT(date, GETDATE()), CONVERT(date, GETDATE()), @mergeado, 0)
            `);

        res.json({ success: true, message: 'Recurso criado com sucesso' });

    } catch (error) {
        console.error('Erro ao criar recurso manual:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});



app.get('/merged-prs-files-range', async (req, res) => {
    const from = req.query.from; // ex: ?from=2024-01-01
    if (!from) {
        return res.status(400).json({ success: false, error: 'Parâmetro "from" é obrigatório no formato YYYY-MM-DD' });
    }

    try {
        await poolConnect;
        const start = new Date(from);
        const end = new Date();
        let current = new Date(start);

        while (current <= end) {
            const dateStr = current.toISOString().slice(0, 10); // YYYY-MM-DD
            console.log(`🔎 Processando PRs mergeados em: ${dateStr}`);

            // 1) checa rate limit
            const remaining = await getRateLimit();
            if (remaining <= 100) {
                return res.status(429).json({
                    success: false,
                    error: `Rate limit baixo: apenas ${remaining} chamadas restantes.`
                });
            }

            // 2) busca PRs do dia
            const prs = await getMergedPRsByDate(dateStr);

            // 3) insere no banco sem duplicar
            for (const pr of prs) {
                await delay(200);
                const files = await getPRFiles(pr.number);
                const filtered = files.filter(f =>
                    FILE_EXTENSIONS.some(ext => f.filename.toLowerCase().endsWith(ext))
                );

                for (const file of filtered) {
                    await delay(200);
                    const check = await pool.request()
                        .input('recurso', sql.NVarChar(500), file.filename)
                        .input('pr', sql.Int, pr.number)
                        .query(`SELECT TOP 1 id FROM Recursos WHERE recurso=@recurso AND pr=@pr`);

                    if (check.recordset.length === 0) {
                        await pool.request()
                            .input('recurso', sql.NVarChar(500), file.filename)
                            .input('usuario', sql.NVarChar(255), pr.user?.login || 'Desconhecido')
                            .input('pr', sql.Int, pr.number)
                            .input('mergeado', sql.DateTime, pr.pull_request.merged_at)
                            .query(`
                  INSERT INTO Recursos
                    (recurso, observacao, ambiente, usuario, pr, criado, atualizado, mergeado, integrado)
                  VALUES
                    (@recurso, '', 'Produção / Schedule', @usuario, @pr,
                     CONVERT(date, GETDATE()), CONVERT(date, GETDATE()), @mergeado, 0)
                `);
                    }
                }
            }

            // 4) aguarda 200 ms antes do próximo dia
            await delay(200);
            current.setDate(current.getDate() + 1);
        }

        res.json({ success: true, message: 'Importação finalizada sem duplicidades.' });
    } catch (error) {
        console.error('Erro ao processar range:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/get-next-available-pr', async (req, res) => {
    try {
        await poolConnect;
        const { recurso } = req.query;

        // Encontra o menor PR não utilizado para o recurso
        const result = await pool.request()
            .input('recurso', sql.NVarChar(500), recurso)
            .query(`
                DECLARE @MinAvailablePR INT;

                ;WITH UsedPRs AS (
                    SELECT pr 
                    FROM Recursos 
                    WHERE recurso = @recurso AND pr IS NOT NULL
                ),
                AllPRs AS (
                    SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS pr
                    FROM master..spt_values
                )
                SELECT TOP 1 @MinAvailablePR = a.pr
                FROM AllPRs a
                LEFT JOIN UsedPRs u ON a.pr = u.pr
                WHERE u.pr IS NULL
                ORDER BY a.pr ASC;

                SELECT @MinAvailablePR AS nextAvailablePR;
            `);

        res.json({
            success: true,
            pr: result.recordset[0].nextAvailablePR || 1
        });

    } catch (error) {
        console.error('Erro ao buscar próximo PR:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>Status da API</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background-color: #f4f4f4;
                    margin: 0;
                    padding: 20px;
                    color: #333;
                }
                .container {
                    max-width: 800px;
                    margin: auto;
                    background: #fff;
                    padding: 30px;
                    border-radius: 8px;
                    box-shadow: 0 0 10px rgba(0,0,0,0.1);
                }
                h1 {
                    color: #0066cc;
                    margin-bottom: 10px;
                }
                p.status {
                    font-size: 1.1em;
                    margin-bottom: 20px;
                    color: green;
                    font-weight: bold;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 20px;
                }
                th, td {
                    padding: 12px;
                    border: 1px solid #ddd;
                    text-align: left;
                }
                th {
                    background-color: #0066cc;
                    color: #fff;
                }
                a {
                    color: #0066cc;
                    text-decoration: none;
                }
                a:hover {
                    text-decoration: underline;
                }
                .footer {
                    font-size: 0.9em;
                    color: #666;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>API Recursos - Status</h1>
                <p class="status">✅ API Online e funcionando!</p>

                <h2>Rotas Disponíveis</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Rota</th>
                            <th>Método</th>
                            <th>Descrição</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><a href="/merged-prs-files">/merged-prs-files</a></td>
                            <td>GET</td>
                            <td>Importa PRs mergeados de hoje</td>
                        </tr>
                        <tr>
                            <td><a href="/recursos">/recursos</a></td>
                            <td>GET</td>
                            <td>Lista recursos com base no status de integração</td>
                        </tr>
                        <tr>
                            <td><a href="/recursos-info?fonte=EXEMPLO">/recursos-info?fonte=EXEMPLO</a></td>
                            <td>GET</td>
                            <td>Informações sobre fontes RPO</td>
                        </tr>
                        <tr>
                            <td><a href="/merged-prs-files-range?from=2025-05-22">/merged-prs-files-range?from=YYYY-MM-DD</a></td>
                            <td>GET</td>
                            <td>Importa PRs mergeados em um intervalo</td>
                        </tr>
                        <tr>
                            <td><a href="/get-next-available-pr?recurso=EXEMPLO">/get-next-available-pr?recurso=EXEMPLO</a></td>
                            <td>GET</td>
                            <td>Próximo número de PR disponível</td>
                        </tr>
                    </tbody>
                </table>

                <div class="footer">
                    <p>Versão: 1.0.0</p>
                    <p>Ambiente: ${process.env.NODE_ENV || 'Desenvolvimento'}</p>
                    <p>&copy; ${new Date().getFullYear()} - API Recursos</p>
                </div>
            </div>
        </body>
        </html>
    `);
});
