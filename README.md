# AI Usage Intelligence

Aplicación de escritorio **local-first** para Windows que monitorea en vivo el consumo real de cuota, tokens y costo equivalente de API para **OpenAI Codex** y **Google Antigravity**.

> **Privacidad por diseño:** todo corre localmente en tu equipo. Las vistas previas de tus preguntas solo viven en memoria y **nunca se escriben en disco**; no se leen ni exportan credenciales, cookies ni texto de conversaciones.

## Características principales

- **Monitoreo multiproveedor en paralelo (`Codex` y `Antigravity`):**
  - **Codex:** consulta cuota oficial en vivo (`5 horas` y `Semanal`) vía `codex app-server` (`account/rateLimits/read`) y analiza rollouts locales (`.jsonl` / `.jsonl.zst`) con caché incremental.
  - **Antigravity:** consulta las **4 ventanas oficiales en vivo** (`Gemini 5 h`, `Gemini Semanal`, `Claude / GPT 5 h`, `Claude / GPT Semanal`) vía `agy -p "/usage" --output-format json` (0 tokens consumidos) y lee en modo solo lectura las bases locales de `~/.gemini/antigravity/conversations/*.db` (`node:sqlite`).
- **Equivalente teórico de API con tarifas oficiales:**
  - Calcula el costo equivalente por **llamada**, por **pregunta**, por **sesión** y en ventanas de **24 h · 7 días · 30 días**.
  - Respeta la semántica exacta de tokens por proveedor (entrada inclusiva vs. exclusiva de caché, razonamiento incluido en salida) y aplica **tramos de contexto largo** (`> 272k` en OpenAI GPT-6.x / 5.4 y `> 200k` en Gemini Pro) llamada por llamada.
  - Calcula **ahorro real por prompt caching** y **cache hit rate (%)**.
  - **Sincronización automática cada 24 h** del catálogo público de precios en segundo plano, con tarifas oficiales fechadas como base prioritaria.
- **Dashboard moderno y analítica profunda:**
  - **Resumen:** cuotas en vivo con cuenta regresiva, selector `24 h / 7 días / 30 días`, gráfica de gasto por hora/día, donut de composición del costo (Entrada / Caché / Salida), ranking por proyecto, **gasto por modelo expandible por nivel de razonamiento**, y evolución de cuota con área degradada.
  - **Preguntas:** filtros por proyecto, sesión, búsqueda en vivo, ventana de cuota y ordenamiento; **comparativa de modelos y niveles de razonamiento dentro de la misma sesión**; inspector con chips de metadatos, distribución de tokens y desglose por llamada.
  - **Análisis:** promedios de consumo de cuota (`5 h` y `Semanal`) y costo API por sesión y por turno, más gráfica y tabla comparativa multimétrica (`Costo`, `$/turno`, `Tokens`, `% Razonam.`, `% Caché`, `Baja 5 h`).
  - **Historial y Fuentes:** tabla con delta (`Δ 5 h`) entre muestras consecutivas, salud de fuentes y estado del catálogo de tarifas.
  - **Tema claro y oscuro:** detecta automáticamente la preferencia de Windows y permite alternar con un clic.

## Requisitos

- **Windows 10 / 11 (x64)**
- **[.NET 10 SDK / Desktop Runtime](https://dotnet.microsoft.com/)**
- **[Node.js 24+](https://nodejs.org/)** (requerido por `node:sqlite` y descompresión Zstandard nativa)
- Al menos uno de los proveedores autenticados en tu equipo:
  - **OpenAI Codex** (sesión iniciada con ChatGPT)
  - **Google Antigravity** + CLI oficial **`agy`** (`irm https://antigravity.google/cli/install.ps1 | iex`)

## Compilar y ejecutar

Desde PowerShell en la raíz del repositorio:

```powershell
.\build.ps1
```

El script ejecuta los 30 tests unitarios, compila la app WPF en Release (`win-x64`) y genera `Abrir AI Usage Intelligence.exe` en la raíz (ignorado por Git).

Para correr solo las pruebas unitarias:

```powershell
node --test poc/poc.test.mjs poc/antigravity.test.mjs poc/pricing.test.mjs
```

## Estructura del proyecto

```text
├── build.ps1                    # Tests + compilación + generación del ejecutable
├── desktop/                     # App de escritorio WPF (.NET 10)
│   ├── App.xaml                 # Tokens de tema y scrollbars modernas
│   ├── MainWindow.xaml(.cs)     # Coordinador principal de vistas
│   ├── ChartRenderer.cs         # Gráficas vectoriales (barras, donut, comparativas, cuota)
│   ├── Collector.cs             # Gestión multiproveedor y decodificación off-UI-thread
│   ├── Models.cs                # Modelos y estado por proveedor
│   ├── ThemeManager.cs          # Tema claro / oscuro + detección de Windows
│   └── Formatters.cs            # Formateo regional de moneda, tokens y cuentas regresivas
└── poc/                         # Colectores desacoplados y motor analítico (Node.js 24)
    ├── codex-poc.mjs            # Daemon de Codex (App Server + rollouts)
    ├── antigravity-poc.mjs      # Daemon de Antigravity (agy CLI + SQLite)
    ├── pricing.mjs              # Catálogo oficial de tarifas y calculadora por llamada
    ├── pricing-sync.mjs         # Sincronización HTTPS cada 24 h con validación estricta
    ├── report.mjs               # Agregación 24h/7d/30d, modelo×esfuerzo y sesiones
    └── *.test.mjs               # Suite de pruebas unitarias
```

## Documentación técnica

- [Arquitectura del sistema](ARCHITECTURE.md)
- [Metodología de medición y precios API](MEASUREMENT_METHODOLOGY.md)
- [Seguridad y privacidad](SECURITY.md)
- [Guía CLI de colectores y pruebas](poc/README.md)
