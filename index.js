require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 1000 * 60 * 60 * 8
    }
}));

const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'control_financiero',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 5
});

db.query('SELECT 1', (err) => {
    if (err) console.error('❌ Error MySQL:', err.message);
    else console.log('✅ Conectado a MySQL con éxito.');
});

function soloAdmin(req, res, next) {
    if (req.session && req.session.usuario && req.session.usuario.rol === 'admin') {
        return next();
    }
    return res.status(403).json({ error: 'Acceso denegado: Se requieren permisos de Administrador.' });
}

// NUEVO: Middleware de validación para ingresos/egresos
function validarMovimiento(req, res, next) {
    const { descripcion, monto, fecha, categoria } = req.body;
    const errores = [];

    if (!categoria || typeof categoria !== 'string' || categoria.trim().length === 0) {
        errores.push('Debes seleccionar una categoría.');
    }

    if (!descripcion || typeof descripcion !== 'string' || descripcion.trim().length === 0) {
        errores.push('La descripción no puede estar vacía.');
    } else if (descripcion.trim().length > 255) {
        errores.push('La descripción es demasiado larga (máximo 255 caracteres).');
    }

    const montoNum = parseFloat(monto);
    if (monto === undefined || monto === null || monto === '' || isNaN(montoNum)) {
        errores.push('El monto debe ser un número válido.');
    } else if (montoNum <= 0) {
        errores.push('El monto debe ser mayor a cero.');
    } else if (montoNum > 999999999) {
        errores.push('El monto ingresado es demasiado alto.');
    }

    if (!fecha || isNaN(Date.parse(fecha))) {
        errores.push('La fecha no es válida.');
    }

    if (errores.length > 0) {
        return res.status(400).json({ error: errores.join(' ') });
    }

    req.body.descripcion = descripcion.trim();
    req.body.monto = montoNum;
    next();
}

const formatearFecha = (fecha) => {
    if (!fecha) return '';
    if (fecha instanceof Date) return fecha.toISOString().split('T')[0];
    return String(fecha).split('T')[0];
};

const formatearCOP = (monto) => {
    const valor = Math.round(parseFloat(monto) || 0);
    return `COP ${valor.toLocaleString('es-CO')}`;
};

// --- AUTENTICACIÓN ---
app.post('/api/login', (req, res) => {
    const username = req.body.username ? req.body.username.trim() : '';
    const password = req.body.password ? req.body.password.trim() : '';

    db.query('SELECT * FROM usuarios WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

        const usuario = results[0];
        const esCorrecta = await bcrypt.compare(password, usuario.password);
        if (!esCorrecta) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

        req.session.usuario = { id: usuario.id, username: usuario.username, rol: usuario.rol };
        res.json({ success: true, rol: usuario.rol, username: usuario.username });
    });
});

app.get('/api/quien-soy', (req, res) => {
    if (req.session && req.session.usuario) {
        res.json({ logueado: true, usuario: req.session.usuario });
    } else {
        res.json({ logueado: false, rol: 'lector' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// --- LECTURA (GET) ---
app.get('/api/periodos', (req, res) => {
    db.query('SELECT * FROM periodos ORDER BY fecha_inicio DESC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/periodos/:id/resumen', (req, res) => {
    const pId = req.params.id;
    db.query('SELECT * FROM periodos WHERE id = ?', [pId], (err, periodos) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!periodos.length) return res.status(404).json({ error: 'No encontrado' });

        db.query('SELECT * FROM ingresos WHERE periodo_id = ? ORDER BY id ASC', [pId], (err, ingresos) => {
            if (err) return res.status(500).json({ error: err.message });

            db.query('SELECT * FROM egresos WHERE periodo_id = ? ORDER BY id ASC', [pId], (err, egresos) => {
                if (err) return res.status(500).json({ error: err.message });

                db.query(`
                    SELECT 
                        (SELECT COALESCE(SUM(monto), 0) FROM ingresos WHERE periodo_id = ?) as total_ingresos,
                        (SELECT COALESCE(SUM(monto), 0) FROM egresos WHERE periodo_id = ?) as total_egresos
                `, [pId, pId], (err, totales) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ 
                        periodo: periodos[0], 
                        ingresos: ingresos, 
                        egresos: egresos, 
                        resumen: totales[0] || { total_ingresos: 0, total_egresos: 0 }
                    });
                });
            });
        });
    });
});

app.get('/api/periodos/:id/pdf', (req, res) => {
    const pId = req.params.id;
    db.query('SELECT * FROM periodos WHERE id = ?', [pId], (err, periodos) => {
        if (err || !periodos.length) return res.status(404).send('Período no encontrado');
        const p = periodos[0];

        db.query('SELECT * FROM ingresos WHERE periodo_id = ?', [pId], (err, ing) => {
            db.query('SELECT * FROM egresos WHERE periodo_id = ?', [pId], (err, egr) => {
                const inicial = parseFloat(p.saldo_inicial);
                const totIng = ing.reduce((sum, item) => sum + parseFloat(item.monto), 0);
                const totEg = egr.reduce((sum, item) => sum + parseFloat(item.monto), 0);
                const final = inicial + totIng - totEg;

                const doc = new PDFDocument({ margin: 50 });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=Reporte_${p.nombre_periodo.replace(/\s+/g, '_')}.pdf`);
                doc.pipe(res);

                doc.fillColor('#2c3e50').fontSize(24).text('REPORTE FINANCIERO MENSUAL', { align: 'center' });
                doc.fontSize(14).text(`Periodo Contable: ${p.nombre_periodo}`, { align: 'center' });
                doc.moveDown(2);

                doc.fillColor('#34495e').fontSize(16).text('Resumen de Cuentas Consolidadas:');
                doc.fontSize(12).text(`• Saldo de Apertura (Inicial): ${formatearCOP(inicial)}`);
                doc.fillColor('#2ecc71').text(`• Entradas Totales (+): ${formatearCOP(totIng)}`);
                doc.fillColor('#e74c3c').text(`• Salidas Totales (-): ${formatearCOP(totEg)}`);
                doc.fillColor('#2c3e50').font('Helvetica-Bold').text(`• BALANCE DE CIERRE (SALDO FINAL): ${formatearCOP(final)}`);
                doc.font('Helvetica').moveDown(2);

                doc.fontSize(14).text('Desglose Analitico de Movimientos:').moveDown(1);
                doc.fontSize(11).fillColor('#27ae60').text('--- DETALLE DE INGRESOS ---');
                ing.forEach(i => {
                    doc.fillColor('#333').text(`${formatearFecha(i.fecha)} - ${i.descripcion}: ${formatearCOP(i.monto)}`);
                });

                doc.moveDown(1).fillColor('#c0392b').text('--- DETALLE DE EGRESOS ---');
                egr.forEach(e => {
                    doc.fillColor('#333').text(`${formatearFecha(e.fecha)} - ${e.descripcion}: -${formatearCOP(e.monto)}`);
                });

                doc.end();
            });
        });
    });
});

app.get('/api/periodos/:id/excel', async (req, res) => {
    const pId = req.params.id;
    try {
        const periodos = await new Promise((resolve, reject) => {
            db.query('SELECT * FROM periodos WHERE id = ?', [pId], (err, r) => err ? reject(err) : resolve(r));
        });
        if (!periodos.length) return res.status(404).send('Período no encontrado');
        const p = periodos[0];

        const ing = await new Promise((resolve, reject) => {
            db.query('SELECT * FROM ingresos WHERE periodo_id = ? ORDER BY fecha', [pId], (err, r) => err ? reject(err) : resolve(r));
        });
        const egr = await new Promise((resolve, reject) => {
            db.query('SELECT * FROM egresos WHERE periodo_id = ? ORDER BY fecha', [pId], (err, r) => err ? reject(err) : resolve(r));
        });

        const inicial = parseFloat(p.saldo_inicial);
        const totIng = ing.reduce((sum, item) => sum + parseFloat(item.monto), 0);
        const totEg = egr.reduce((sum, item) => sum + parseFloat(item.monto), 0);
        const final = inicial + totIng - totEg;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Control Financiero Personal';
        workbook.created = new Date();

        const formatoMoneda = '"COP" #,##0';

        const wsResumen = workbook.addWorksheet('Resumen');
        wsResumen.columns = [
            { header: 'Concepto', key: 'concepto', width: 30 },
            { header: 'Valor', key: 'valor', width: 22 }
        ];

        wsResumen.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        wsResumen.addRow({ concepto: `Período: ${p.nombre_periodo}`, valor: '' });
        wsResumen.mergeCells('A2:B2');
        wsResumen.getCell('A2').font = { bold: true, italic: true };

        const filaInicial = wsResumen.addRow({ concepto: 'Saldo Inicial', valor: inicial });
        const filaIngresos = wsResumen.addRow({ concepto: 'Total Ingresos', valor: totIng });
        const filaEgresos = wsResumen.addRow({ concepto: 'Total Egresos', valor: totEg });
        const filaFinal = wsResumen.addRow({ concepto: 'Saldo Final', valor: final });

        [filaInicial, filaIngresos, filaEgresos, filaFinal].forEach(fila => {
            fila.getCell(2).numFmt = formatoMoneda;
            fila.getCell(2).alignment = { horizontal: 'right' };
        });
        filaIngresos.getCell(2).font = { color: { argb: 'FF27AE60' }, bold: true };
        filaEgresos.getCell(2).font = { color: { argb: 'FFC0392B' }, bold: true };
        filaFinal.getCell(1).font = { bold: true };
        filaFinal.getCell(2).font = { bold: true, color: { argb: 'FF2980B9' } };
        filaFinal.eachCell(cell => {
            cell.border = { top: { style: 'thin' } };
        });

        const wsIng = workbook.addWorksheet('Ingresos');
        wsIng.columns = [
            { header: 'Fecha', key: 'fecha', width: 15 },
            { header: 'Descripción', key: 'descripcion', width: 38 },
            { header: 'Monto', key: 'monto', width: 20 }
        ];
        wsIng.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF27AE60' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        ing.forEach(i => {
            const fila = wsIng.addRow({ fecha: formatearFecha(i.fecha), descripcion: i.descripcion, monto: parseFloat(i.monto) });
            fila.getCell(3).numFmt = formatoMoneda;
            fila.getCell(3).alignment = { horizontal: 'right' };
        });
        wsIng.addRow({});
        const totalIngRow = wsIng.addRow({ fecha: '', descripcion: 'TOTAL', monto: totIng });
        totalIngRow.font = { bold: true };
        totalIngRow.getCell(3).numFmt = formatoMoneda;
        totalIngRow.getCell(3).alignment = { horizontal: 'right' };
        totalIngRow.eachCell(cell => cell.border = { top: { style: 'thin' } });
        wsIng.views = [{ state: 'frozen', ySplit: 1 }];

        const wsEgr = workbook.addWorksheet('Egresos');
        wsEgr.columns = [
            { header: 'Fecha', key: 'fecha', width: 15 },
            { header: 'Descripción', key: 'descripcion', width: 38 },
            { header: 'Monto', key: 'monto', width: 20 }
        ];
        wsEgr.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE74C3C' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
        egr.forEach(e => {
            const fila = wsEgr.addRow({ fecha: formatearFecha(e.fecha), descripcion: e.descripcion, monto: parseFloat(e.monto) });
            fila.getCell(3).numFmt = formatoMoneda;
            fila.getCell(3).alignment = { horizontal: 'right' };
        });
        wsEgr.addRow({});
        const totalEgrRow = wsEgr.addRow({ fecha: '', descripcion: 'TOTAL', monto: totEg });
        totalEgrRow.font = { bold: true };
        totalEgrRow.getCell(3).numFmt = formatoMoneda;
        totalEgrRow.getCell(3).alignment = { horizontal: 'right' };
        totalEgrRow.eachCell(cell => cell.border = { top: { style: 'thin' } });
        wsEgr.views = [{ state: 'frozen', ySplit: 1 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Reporte_${p.nombre_periodo.replace(/\s+/g, '_')}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('❌ Error generando Excel:', err.message);
        res.status(500).send('Error generando el archivo Excel');
    }
});

// --- ESCRITURA (SOLO ADMIN) ---
app.post('/api/periodos', soloAdmin, (req, res) => {
    const { nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin } = req.body;

    if (!nombre_periodo || nombre_periodo.trim().length === 0) {
        return res.status(400).json({ error: 'El nombre del período no puede estar vacío.' });
    }
    const saldoNum = parseFloat(saldo_inicial);
    if (saldo_inicial === undefined || isNaN(saldoNum)) {
        return res.status(400).json({ error: 'El saldo inicial debe ser un número válido.' });
    }
    if (!fecha_inicio || !fecha_fin || isNaN(Date.parse(fecha_inicio)) || isNaN(Date.parse(fecha_fin))) {
        return res.status(400).json({ error: 'Las fechas no son válidas.' });
    }
    if (new Date(fecha_fin) < new Date(fecha_inicio)) {
        return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la fecha de inicio.' });
    }

    db.query(
        'INSERT INTO periodos (nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin) VALUES (?, ?, ?, ?)', 
        [nombre_periodo.trim(), saldoNum, fecha_inicio, fecha_fin], 
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.post('/api/ingresos', soloAdmin, validarMovimiento, (req, res) => {
    const { periodo_id, descripcion, monto, fecha, categoria } = req.body;
    db.query(
        'INSERT INTO ingresos (periodo_id, descripcion, monto, fecha, categoria) VALUES (?, ?, ?, ?, ?)', 
        [periodo_id, descripcion, monto, fecha, categoria], 
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.post('/api/egresos', soloAdmin, validarMovimiento, (req, res) => {
    const { periodo_id, descripcion, monto, fecha, categoria } = req.body;
    db.query(
        'INSERT INTO egresos (periodo_id, descripcion, monto, fecha, categoria) VALUES (?, ?, ?, ?, ?)', 
        [periodo_id, descripcion, monto, fecha, categoria], 
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.put('/api/ingresos/:id', soloAdmin, validarMovimiento, (req, res) => {
    const { descripcion, monto, fecha, categoria } = req.body;
    db.query(
        'UPDATE ingresos SET descripcion = ?, monto = ?, fecha = ?, categoria = ? WHERE id = ?',
        [descripcion, monto, fecha, categoria, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.put('/api/egresos/:id', soloAdmin, validarMovimiento, (req, res) => {
    const { descripcion, monto, fecha, categoria } = req.body;
    db.query(
        'UPDATE egresos SET descripcion = ?, monto = ?, fecha = ?, categoria = ? WHERE id = ?',
        [descripcion, monto, fecha, categoria, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.delete('/api/ingresos/:id', soloAdmin, (req, res) => {
    db.query('DELETE FROM ingresos WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.sendStatus(200);
    });
});

app.delete('/api/egresos/:id', soloAdmin, (req, res) => {
    db.query('DELETE FROM egresos WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.sendStatus(200);
    });
});

app.post('/api/periodos/:id/cerrar', soloAdmin, (req, res) => {
    const pId = req.params.id;
    const { nuevo_nombre, nueva_fecha_inicio, nueva_fecha_fin } = req.body;

    if (!nuevo_nombre || nuevo_nombre.trim().length === 0) {
        return res.status(400).json({ error: 'El nombre del nuevo período no puede estar vacío.' });
    }
    if (!nueva_fecha_inicio || !nueva_fecha_fin || isNaN(Date.parse(nueva_fecha_inicio)) || isNaN(Date.parse(nueva_fecha_fin))) {
        return res.status(400).json({ error: 'Las fechas no son válidas.' });
    }
    if (new Date(nueva_fecha_fin) < new Date(nueva_fecha_inicio)) {
        return res.status(400).json({ error: 'La fecha de fin no puede ser anterior a la fecha de inicio.' });
    }

    const sqlCalc = `
        SELECT 
            p.saldo_inicial + 
            COALESCE((SELECT SUM(monto) FROM ingresos WHERE periodo_id = p.id), 0) - 
            COALESCE((SELECT SUM(monto) FROM egresos WHERE periodo_id = p.id), 0) AS saldo_final
        FROM periodos p
        WHERE p.id = ?;
    `;

    db.query(sqlCalc, [pId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!results.length) return res.status(404).json({ error: 'Período no encontrado' });

        const saldoFinalCalculado = results[0].saldo_final;
        db.query(
            'INSERT INTO periodos (nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin) VALUES (?, ?, ?, ?)',
            [nuevo_nombre.trim(), saldoFinalCalculado, nueva_fecha_inicio, nueva_fecha_fin], 
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            }
        );
    });
});

app.listen(PORT, () => console.log(`💻 Servidor activo en http://localhost:${PORT}`));
