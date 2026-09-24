# Control Financiero

Aplicación web para llevar el control de ingresos y egresos personales, organizados por periodos contables (por ejemplo, un mes). Los valores se muestran en pesos colombianos (COP).

## Funcionalidades

- Cualquier visitante puede ver los periodos y sus movimientos en modo **lector** (solo lectura).
- Los usuarios con rol **admin** inician sesión y pueden crear periodos, registrar, editar y eliminar ingresos y egresos, y cerrar periodos.
- Resumen financiero por periodo.
- Exportación de reportes en **PDF** y **Excel**.

## Tecnologías

- Node.js y Express
- MySQL 8
- `express-session` para las sesiones y `bcrypt` para proteger las contraseñas
- `pdfkit` y `exceljs` para los reportes
- HTML y JavaScript en el frontend (carpeta `public/`)

## Requisitos

- Node.js 18 o superior
- MySQL 8

## Instalación

1. Clona el repositorio e instala las dependencias:

```bash
git clone https://github.com/SelenLamont/control-financiero.git
cd control-financiero
npm install
```

2. Crea la base de datos y las tablas:

```bash
mysql -u root -p -e "CREATE DATABASE control_financiero;"
mysql -u root -p control_financiero < schema.sql
```

> Atención: `schema.sql` incluye `DROP TABLE IF EXISTS`. Si lo ejecutas sobre una base que ya tiene datos, las tablas se borrarán y quedarán vacías.

3. Crea un archivo `.env` en la raíz del proyecto:

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_contraseña_de_mysql
DB_NAME=control_financiero
SESSION_SECRET=una_clave_larga_y_aleatoria
```

Puedes generar el `SESSION_SECRET` con:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

4. Crea el primer usuario administrador. La app no tiene página de registro, así que se inserta directamente en MySQL con la contraseña cifrada.

Primero genera el hash de tu contraseña:

```bash
node -e "require('bcrypt').hash('tu_contraseña', 10).then(console.log)"
```

Luego entra a MySQL con `mysql -u root -p` y ejecuta, pegando el hash obtenido:

```sql
USE control_financiero;
INSERT INTO usuarios (username, password, rol)
VALUES ('admin', 'EL_HASH_QUE_OBTUVISTE', 'admin');
```

El rol puede ser `admin` o `lector`.

## Uso

```bash
node index.js
```

Abre `http://localhost:3000` en el navegador. Si quieres otro puerto, agrega `PORT=4000` (por ejemplo) al `.env`.

Pulsa **Iniciar Sesión** e ingresa con el usuario que creaste.

## Estructura de la base de datos

| Tabla | Descripción |
|---|---|
| `usuarios` | Usuarios de la app, con su rol (`admin` o `lector`) |
| `periodos` | Periodos contables, con saldo inicial y fechas |
| `ingresos` | Ingresos registrados en cada periodo |
| `egresos` | Egresos registrados en cada periodo |

## Estructura del proyecto

```
index.js                  Servidor, rutas de la API y reportes
public/index.html         Lista de periodos e inicio de sesión
public/movimientos.html   Detalle de ingresos y egresos de un periodo
schema.sql                Estructura de la base de datos
```

## Nota de seguridad

Esta app está pensada para uso local o de aprendizaje. Antes de publicarla en internet hay que servirla con HTTPS y ajustar la configuración de las cookies de sesión.