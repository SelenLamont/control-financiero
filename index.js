const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const PDFDocument = require('pdfkit');
const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'AveMaria\$33',
    database: 'control_financiero'
});

db.connect((err) => {
    if (err) console.error('❌ Error MySQL:', err.message);
    else console.log('✅ Conectado a MySQL con éxito.');
});

app.get('/api/periodos', (req, res) => {
    db.query('SELECT * FROM periodos ORDER BY fecha_inicio DESC', (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

app.post('/api/periodos', (req, res) => {
    const { nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin } = req.body;
    db.query('INSERT INTO periodos (nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin) VALUES (?, ?, ?, ?)', 
    [nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin], () => res.redirect('/'));
});

app.get('/api/periodos/:id/resumen', (req, res) => {
    const pId = req.params.id;
    db.query('SELECT * FROM periodos WHERE id = ?', [pId], (err, periodos) => {
        if (!periodos.length) return res.status(404).json({ error: 'No encontrado' });
        
        db.query('SELECT * FROM ingresos WHERE periodo_id = ? ORDER BY fecha DESC', [pId], (err, ingresos) => {
            db.query('SELECT * FROM egresos WHERE periodo_id = ? ORDER BY fecha DESC', [pId], (err, egresos) => {
                db.query(`
                    SELECT 
                        (SELECT SUM(monto) FROM ingresos WHERE periodo_id = ?) as total_ingresos,
                        (SELECT SUM(monto) FROM egresos WHERE periodo_id = ?) as total_egresos
                `, [pId, pId], (err, totales) => {
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

app.post('/api/ingresos', (req, res) => {
    const { periodo_id, descripcion, monto, fecha } = req.body;
    db.query('INSERT INTO ingresos (periodo_id, descripcion, monto, fecha) VALUES (?, ?, ?, ?)', [periodo_id, descripcion, monto, fecha], () => res.sendStatus(200));
});

app.post('/api/egresos', (req, res) => {
    const { periodo_id, descripcion, monto, fecha } = req.body;
    db.query('INSERT INTO egresos (periodo_id, descripcion, monto, fecha) VALUES (?, ?, ?, ?)', [periodo_id, descripcion, monto, fecha], () => res.sendStatus(200));
});

app.delete('/api/ingresos/:id', (req, res) => {
    db.query('DELETE FROM ingresos WHERE id = ?', [req.params.id], () => res.sendStatus(200));
});

app.delete('/api/egresos/:id', (req, res) => {
    db.query('DELETE FROM egresos WHERE id = ?', [req.params.id], () => res.sendStatus(200));
});

app.post('/api/periodos/:id/cerrar', (req, res) => {
    const pId = req.params.id;
    const { nuevo_nombre, nueva_fecha_inicio, nueva_fecha_fin } = req.body;
    const sqlCalc = `
        SELECT p.saldo_inicial + COALESCE(SUM(i.monto), 0) - COALESCE(SUM(e.monto), 0) AS saldo_final
        FROM periodos p
        LEFT JOIN ingresos i ON p.id = i.periodo_id
        LEFT JOIN egresos e ON p.id = e.periodo_id
        WHERE p.id = ?;
    `;
    db.query(sqlCalc, [pId], (err, results) => {
        const saldoFinalCalculado = results[0].saldo_final;
        db.query('INSERT INTO periodos (nombre_periodo, saldo_inicial, fecha_inicio, fecha_fin) VALUES (?, ?, ?, ?)',
        [nuevo_nombre, saldoFinalCalculado, nueva_fecha_inicio, nueva_fecha_fin], () => {
            res.sendStatus(200);
        });
    });
});

app.get('/api/periodos/:id/pdf', (req, res) => {
    const pId = req.params.id;
    db.query('SELECT * FROM periodos WHERE id = ?', [pId], (err, periodos) => {
        if (!periodos.length) return res.status(404).send('Período no encontrado');
        const p = periodos[0];
        db.query('SELECT * FROM ingresos WHERE periodo_id = ?', [pId], (err, ing) => {
            db.query('SELECT * FROM egresos WHERE periodo_id = ?', [pId], (err, egr) => {
                const inicial = parseFloat(p.saldo_inicial);
                const totIng = ing.reduce((sum, item) => sum + parseFloat(item.monto), 0);
                const totEg = egr.reduce((sum, item) => sum + parseFloat(item.monto), 0);
                const final = inicial + totIng - totEg;

                const doc = new PDFDocument({ margin: 50 });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename=Reporte_${p.nombre_periodo.replace(' ', '_')}.pdf`);
                doc.pipe(res);

                doc.fillColor('#2c3e50').fontSize(24).text('REPORTE FINANCIERO MENSUAL', { align: 'center' });
                doc.fontSize(14).text(`Periodo Contable: ${p.nombre_periodo}`, { align: 'center' });
                doc.moveDown(2);

                doc.fillColor('#34495e').fontSize(16).text('Resumen de Cuentas Consolidadas:');
                doc.fontSize(12).text(`• Saldo de Apertura (Inicial): $${inicial.toFixed(2)}`);
                doc.fillColor('#2ecc71').text(`• Entradas Totales (+): $${totIng.toFixed(2)}`);
                doc.fillColor('#e74c3c').text(`• Salidas Totales (-): $${totEg.toFixed(2)}`);
                doc.fillColor('#2c3e50').font('Helvetica-Bold').text(`• BALANCE DE CIERRE (SALDO FINAL): $${final.toFixed(2)}`);
                doc.font('Helvetica').moveDown(2);

                doc.fontSize(14).text('Desglose Analitico de Movimientos:').moveDown(1);
                doc.fontSize(11).fillColor('#27ae60').text('--- DETALLE DE INGRESOS ---');
                ing.forEach(i => doc.fillColor('#333').text(`${i.fecha.split ? i.fecha.split('T')[0] : i.fecha} - ${i.descripcion}: +$${parseFloat(i.monto).toFixed(2)}`));
                
                doc.moveDown(1).fillColor('#c0392b').text('--- DETALLE DE EGRESOS ---');
                egr.forEach(e => doc.fillColor('#333').text(`${e.fecha.split ? e.fecha.split('T')[0] : e.fecha} - ${e.descripcion}: -$${parseFloat(e.monto).toFixed(2)}`));

                doc.end();
            });
        });
    });
});

app.listen(PORT, () => console.log(`💻 Todo activo en http://localhost:${PORT}`));
