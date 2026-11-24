# Seguridad y privacidad

AI Usage Intelligence está diseñado bajo un principio estrictamente **local-first** y de **privilegios mínimos**:

## Qué datos se leen y qué se guarda

- **Sin credenciales ni RPCs privados:** nunca se extraen tokens OAuth, cookies ni claves del sistema. Las cuotas se consultan únicamente mediante las interfaces oficiales documentadas (`codex app-server` y `agy -p "/usage"`).
- **Lectura pasiva de historial:** los archivos de rollouts de Codex y las bases SQLite de Antigravity se abren exclusivamente en modo de **solo lectura** (`readOnly: true`).
- **Prompts y vistas previas solo en memoria:** los fragmentos cortos de tus preguntas, los nombres de proyectos y el bloque `analytics` se mantienen únicamente en memoria para mostrarlos en la ventana y **nunca se persisten** en los archivos de grabación `.jsonl`.
- **Seudonimización local:** los identificadores de cuenta, sesión, turno y proyecto se seudonimizan con HMAC-SHA256 usando una sal aleatoria por corrida o un secreto local por usuario (`%LOCALAPPDATA%\AIUsageIntelligence\quota-scope.key`, permisos `0600`).
- **Separación del repositorio:** el `.gitignore` excluye grabaciones (`*.jsonl`), bases de datos (`*.db`, `*.sqlite`), cachés (`pricing-cache.json`), claves (`*.key`), configuraciones personales (`project-folders.json`) y binarios compilados (`*.exe`).

## Controles de seguridad en ejecución

| Superficie | Protección aplicada |
|---|---|
| Subprocesos (`node`, `codex`, `agy`) | Invocación directa sin shell (`UseShellExecute = false`, `ArgumentList` / `execFile`), rutas explícitas validadas como absolutas. |
| Sincronización de precios (`pricing-sync.mjs`) | Solo protocolo `https:`, timeout de 8 s, límite máximo de respuesta de **15 MB**, validación numérica de tarifas, `Object.create(null)` y bloqueo de claves `__proto__` / `constructor` / `prototype`. |
| Decodificación JSON en escritorio (`Collector.cs`) | Límite máximo de **16 MB** por línea JSON antes de parsear para evitar agotamiento de memoria. |
| Archivos de grabación | Escritura acotada en `%LOCALAPPDATA%\AIUsageIntelligence\poc` (fuera de carpetas sincronizadas como OneDrive). |
