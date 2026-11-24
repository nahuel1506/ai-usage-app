# Metodología de medición y atribución

## Evidencia y unidades

Registrar por separado **emisor** (proveedor, cliente local u operador), **canal** (RPC documentado, archivo interno o importación), **naturaleza** (reportado, observado localmente, calculado, inferido, estimado o indisponible) y **cobertura**. Un snapshot histórico de un log puede haber sido emitido por el proveedor y observado vía archivo. Cada cifra auditable conserva fuente, versión, marca temporal del evento y de captura, clave seudonimizada, puntero local sin contenido, estado de completitud y versión de método. Los ceros requieren evidencia explícita o una regla del formato comprobada.

Versionar la semántica de entrada total, entrada fresca, caché leída, caché escrita por TTL, salida visible, salida total y razonamiento. Conservar timestamp en UTC y zona del evento cuando exista; día, semana de calendario y mes se agrupan en zona IANA de la vista. La ventana del proveedor usa su propio reset. No convertir ni sumar porcentajes entre ventanas, pools o proveedores.

### Solicitudes, reintentos y proyecciones

1. Priorizar la unidad de solicitud explícita. Codex moderno aporta IDs de hilo, turno, sesión y respuesta. El flujo acumulado valida la suma o rellena lapsos discontinuos según contrato; el último contador acumulado nunca se suma como si fuera incremental. Cuando el contador baja o cambia la generación del hilo, abrir otro segmento y marcar el salto. Una ausencia de `response_id` conserva granularidad parcial.
2. En Antigravity, deduplicar a través de IDs de respuesta/mensaje, trayectoria, índice, vínculo paso-generación y timestamp con procedencia. Mantener intentos distintos aunque coincidan sus tokens. Si una fila de reintentos repite el intento principal bajo la misma identidad, se cuenta una vez. Un empate ambiguo conserva evidencia sin producir dos cargos ni fusionar a ciegas.
3. Distinguir fecha de registro, inicio y final del turno y tiempos de solicitudes. No atribuir tiempo de herramientas a inferencia ni sumar duraciones de subagentes paralelos para calcular tiempo de pared. Agrupar subagentes por arista explícita y contar cada solicitud una vez. Marcar compactación, reproceso o reintento solo cuando exista una señal observable.
4. Capturar cambios de modelo o esfuerzo con validez temporal y granularidad. Los ajustes preferidos pueden diferir del modelo servido. Un modelo incierto o sin alias trazable tiene costo no calculable a nivel de solicitud.

## Auditoría de cuota

Identidad lógica `proveedor + cuenta + pool + tipo de unidad + duración + época de ventana`. Usar IDs de pool y reset cuando estén disponibles. Versionar la pertenencia de modelos y de superficies a pools con evidencia y fecha. Un cambio de plan, reset anticipado, compra de capacidad, desconexión, retardo largo o reemplazo del identificador separa segmentos o reduce la confianza. Un error de consulta nunca equivale a un reset.

- Tomar el último snapshot anterior al turno con edad visible. Registrar mientras hay actividad y al terminar, y observar estabilización con muestras de control. Las muestras efectivas pueden llegar tarde; un caso retrospectivo se analiza con los tiempos disponibles. No interpolar un punto oficial antes del turno.
- En una ventana compatible calcular `delta_pp = usado_final − usado_inicial`. Si la fuente usa restante, normalizar sin perder el valor original. Usar la granularidad observada o documentada. Si ambos porcentajes se redondean simétricamente al entero más cercano, una caída observada de 3 puntos puede representar aproximadamente 2–4 puntos. Con redondeo desconocido publicar el delta observado y marcar granularidad incierta.
- Encontrar todos los turnos candidatos compatibles con cuenta/pool cuyo intervalo de actividad pueda solaparse con el descenso o con la ventana de retardo calibrada. Atribuir **correlación probable** a un turno único solo con muestras frescas, sin discontinuidad y con cobertura suficiente. Siempre conservar la posibilidad de actividad fuera del equipo.
- Con simultaneidad, compartir el conjunto de candidatos y marcar el descenso como **sin reparto verificable**. En ausencia de evidencia individual, el intervalo por candidato es de cero al máximo compatible con el delta, condicionado al pool y el intervalo. No distribuir proporcionalmente por tokens. Sin candidatos, clasificar el descenso como **actividad sin identificar**; remoto, actualización tardía y hueco local son hipótesis.
- Medir cobertura por fuente, períodos de colector saludable, turnos con muestras antes/después y edad de la cuota. Si una serie converge con el dashboard, registrar la comparación, sin asumir cobertura global por coincidencia ocasional. Estados de evidencia para UI: suficiente, parcial, ambigua e indisponible.

En un ejemplo sintético, un pool desciende 3 puntos entre dos snapshots con dos turnos abiertos. La UI mostraría un solo descenso y los dos candidatos, además de la precisión del snapshot. Un cambio simultáneo en la ventana semanal se presenta en su propia serie.

## Equivalente teórico de API

Seleccionar por proveedor API, SKU exacto o alias verificado, ruta, moneda, versión tarifaria y fecha del evento, tramo de contexto, modo y modificadores pertinentes. Versionar la vigencia conocida y conservar la fecha de consulta; una tarifa vigente hoy no reconstruye actividad anterior por defecto. Guardar razones y cobertura de líneas que queden sin precio.

`Costo = suma(tokens del componente × USD por millón / 1.000.000) + cargos por unidades de herramientas verificadas`.

- **OpenAI.** En un esquema inclusivo, entrada fresca = entrada total menos caché leída y escrituras incluidas cuando sus categorías son disjuntas. Aplicar la tarifa de cada TTL conocido. Si razonamiento ya forma parte de la salida, conservarlo para el diagnóstico y cobrar el total de salida una sola vez. Una categoría de escritura conocida con TTL desconocido puede dar un rango condicionado a tarifas aplicables. [Precios OpenAI](https://developers.openai.com/api/docs/pricing) · [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).
- **Gemini.** Usar el contrato de la ruta y modelo. `promptTokenCount` incluye caché cuando corresponde; el desglose de candidatos y pensamiento debe traducirse a la salida facturable de esa tarifa. El almacenamiento de caché y herramientas como grounding pueden requerir unidades independientes. Los créditos de Antigravity y los precios de Gemini Enterprise o Vertex se muestran aparte cuando corresponda. [Gemini GenerateContent](https://aistudio.google.com/api-reference/generate-content) · [Precios Gemini](https://aistudio.google.com/docs/pricing).
- **Anthropic.** La API expone entrada fresca y buckets separados de lectura/escritura de caché. Aplicar TTL y elegibilidad por modelo y el tratamiento de thinking de esa versión. Si un modelo de terceros en Antigravity carece de equivalencia API verificable, el equivalente queda indisponible. [Precios Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).

Para una sesión con requests completos se agregan resultados por turno, sesión, conversación, proyecto, modelo, proveedor y período. Una agregación con huecos muestra cobertura monetaria y el subtotal observable. Si un tramo o modo faltante afecta el cálculo, indicar el supuesto explícito y la cifra como estimación condicionada o presentar un rango defendible. La compra de suscripción, los créditos observados y el costo teórico tienen unidades y bases separadas.

## Diagnóstico, predicción y laboratorio

Mostrar señales, sus denominadores y evidencia. Por ejemplo, una proporción de caché baja requiere entrada total y lectura de caché compatibles. “Contexto largo” exige ventana conocida o un percentil comparable. Reportar número de solicitudes, tamaños, esfuerzo y reintentos como factores asociados. Evaluar eficiencia con tareas y calidad comparables, y con costo, demora y tokens como ejes separados. La utilidad de una suscripción se puede comparar por cantidad de resultados aceptados y costo de suscripción declarado para el mismo período; no inferir ahorro monetario causal a partir del equivalente de API.

Pronosticar por pool y época. Empezar por percentiles de ritmo y consumo por turno en segmentos comparables, con reinicios y huecos censurados. Punto de partida de validación: cinco ventanas completas y 30 deltas positivos comparables para proyectar el ritmo. Mostrar por separado probabilidad de agotamiento antes del reset, intervalo de tiempo y vigencia. Si faltan muestras o cambia la política, suprimir el pronóstico. Calibrar con ventanas reservadas de forma cronológica.

El laboratorio registra hipótesis, tarea o hash, modelo, esfuerzo, contexto, herramientas, subagentes, estado de caché, plan/pool, estado inicial y final, duración, tokens, costo con cobertura, resultado, rúbrica de calidad, réplicas e incertidumbre. Alternar orden y repetir, controlando concurrencia, calentamiento de caché y horario. La ejecución de tareas queda a cargo del usuario o exige autorización explícita si más adelante se incorpora un ejecutor.

## Autonomía estimada en el monitor

La cuota disponible y los reinicios provienen de las lecturas del proveedor. Por cada ventana y grupo de modelos, la estimación usa hasta 60 prompts recientes de los últimos 30 días con baja positiva, medición antes y después y ausencia de solapamiento con otra actividad local. Se excluyen envíos combinados y cambios de ventana. En Codex se usa el plan actual cuando se conoce. En Antigravity se requieren dos lecturas oficiales y un grupo de modelos identificable.

La app muestra un rango cuando hay al menos ocho casos elegibles. Divide la cuota disponible por los percentiles 75 y 25 de la baja observada por prompt y redondea hacia abajo. El rango representa el 50 % central del historial de bajas y supone un ritmo similar. Las lecturas de 0 % observado pueden ocultar consumo por redondeo y quedan fuera de este cálculo. El número de casos visibles en la app corresponde a la muestra utilizada.

- OpenAI describe la variación por tarea, modelo y configuración, y el efecto de los límites de 5 horas y semanal. [Uso de Work y Codex](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex)
- Google documenta la variación por trabajo realizado y los límites compartidos por grupo. [Planes](https://www.antigravity.google/docs/plans) · [Cuota con /usage](https://antigravity.google/docs/cli/commands/usage?app=antigravity-ide)
- METR mide dificultad de tareas con tiempo humano. SWE-bench Pro mide resolución de tareas de ingeniería bajo un entorno experimental. Esos resultados aportan contexto sobre variación y complejidad. La calibración del presupuesto se hace con las propias lecturas de cuota. [METR](https://metr.org/time-horizons/) · [SWE-bench Pro](https://arxiv.org/abs/2509.16941)
