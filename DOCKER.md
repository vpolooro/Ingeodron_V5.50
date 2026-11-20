# Manual de Instalación y Despliegue en Docker — Portal INGEODRON (v5.50)

Guía completa para instalar y ejecutar la aplicación en **Docker** directamente desde GitHub (`https://github.com/vpolooro/Ingeodron_Ver5.10.git`) mediante **Docker Compose**.

---

## 1. Archivos Docker Incluidos

- **`Dockerfile`** (Multi-stage):
  1. **Etapa 1 (`builder`)**: Instala dependencias y compila el frontend React con Vite (`dist/`).
  2. **Etapa 2 (`runner`)**: Imagen ligera con Node 22 que ejecuta el servidor Express (`server.ts`), sirve la SPA compilada y gestiona `/api/*`, `/files/*` y `/app/storage`.
- **`.dockerignore`**: Excluye `node_modules`, `dist`, `.git`, `.env` y `storage` para acelerar la compilación.
- **`docker-compose.yml`**: Construye la imagen `ingeodron-portal:5.50` desde el directorio actual (`.`) usando el `Dockerfile` (o desde GitHub pasando `GIT_BUILD_CONTEXT`), expone el puerto `3000`, monta el volumen persistente `./storage:/app/storage` y configura `healthcheck`.
- **`docker-compose.git.yml`**: Alternativa pensada para **Portainer / Synology / repositorios privados**, que clona y compila al arrancar usando la variable `GITHUB_TOKEN` y soporta `AUTO_UPDATE=true`.
- **`docker-compose.https.yml`**: Extensión opcional con proxy inverso **Caddy** y HTTPS automático (Let's Encrypt).
- **`.env.example`**: Plantilla de variables de entorno (`APP_PORT`, `APP_URL`, `SESSION_SECRET`, etc.).

> **Persistencia de datos:** Todos los entregables, clientes y usuarios se guardan en el host en `./storage/`.

---

## 2. Requisitos Previos

- **Docker Desktop** (Windows / macOS) o **Docker Engine + Docker Compose v2** (Linux).

```bash
docker --version
docker compose version
```

---

## 3. Instalación y Despliegue en Docker

### Opción A: Compilar y arrancar en local con `docker-compose.yml` (Recomendado)

Desde la carpeta raíz del proyecto:

```bash
docker compose up -d --build
```

La aplicación quedará disponible en **`http://localhost:3000`**.

Si quieres compilar directamente desde GitHub en lugar de usar los archivos locales:

```bash
GIT_BUILD_CONTEXT="https://github.com/vpolooro/Ingeodron_Ver5.10.git#main" docker compose up -d --build
```

### Opción B: Construir la imagen y subirla a Docker Hub / Registry

```bash
docker build -t tuusuario/ingeodron-portal:5.50 .
docker login
docker push tuusuario/ingeodron-portal:5.50
```

O exportar la imagen en un archivo `.tar` para llevarla a otro servidor sin conexión:

```bash
docker save -o ingeodron-portal-5.50.tar ingeodron-portal:5.50
# En el servidor de destino:
docker load -i ingeodron-portal-5.50.tar
```

---

### Opción C: Repositorio privado o despliegue en Portainer (`docker-compose.git.yml`)

Si el repositorio es **privado** o despliegas desde Portainer / Synology Container Manager:

- **Linux / macOS:**
  ```bash
  GITHUB_TOKEN="ghp_tu_token" SESSION_SECRET="tu_clave_segura" docker compose -f docker-compose.git.yml up -d
  ```
- **Windows PowerShell:**
  ```powershell
  $env:GITHUB_TOKEN="ghp_tu_token"
  $env:SESSION_SECRET="tu_clave_segura"
  docker compose -f docker-compose.git.yml up -d
  ```

---

### Opción C: Con dominio propio y HTTPS automático (Let's Encrypt)

```bash
DOMAIN=portal.tudominio.es SESSION_SECRET="tu_clave_segura" docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

---

## 4. Comandos Útiles

| Acción | Comando |
| :--- | :--- |
| Instalar / compilar y arrancar | `docker compose up -d --build` |
| Ver estado y healthcheck | `docker compose ps` |
| Ver logs en tiempo real | `docker compose logs -f ingeodron-portal` |
| Reiniciar contenedor | `docker compose restart` |
| Detener contenedores | `docker compose down` |
| Actualizar desde GitHub sin caché | `docker compose build --no-cache && docker compose up -d` |
