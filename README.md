# Padron CABA

Aplicacion SAPUI5 desplegada en SAP BTP para procesar el padron de percepciones de CABA.

## Version actual — 27/08/2026

`main` contiene la UI 0.1.5 y la API probadas en DEV y promovidas a TEST:
filtro de clientes extendidos a la sociedad 2384, validacion adicional en el
backend y recuperacion del seguimiento del job al reabrir la aplicacion.
Incluye las seis suites de pruebas. Las notas siguientes conservan el historial
de cada paso; publicar este repositorio no ejecuta un despliegue.

El parser actual todavia carga el TXT completo en la memoria del navegador.
No se garantiza capacidad para cualquier archivo de millones de lineas: queda
pendiente optimizar la lectura por bloques y validar el volumen real. El job
usa `setImmediate` en la API; guardar su estado no permite reanudarlo
automaticamente si se reinicia la instancia. No contiene padrones ni credenciales.

## Estado de la recuperacion

La etiqueta `recovery-0.1.2` conserva exactamente la interfaz recuperada desde HTML5 Application Repository el 24/08/2026.

La rama `main` contiene el proyecto fuente reconstruido. La version 0.1.3 incorpora:

- filtro exclusivamente visual para mostrar la sociedad 2384;
- estado persistente del job al volver a ingresar;
- barra de progreso calculada desde los mensajes persistidos por el backend.

La logica funcional y los endpoints del backend no se modificaron con esos cambios visuales de la version 0.1.3.

## Filtro funcional por sociedad (0.1.4, desplegado en DEV el 27/08/2026)

El filtro ahora exige que el CUIT corresponda a un BP con numero de cliente y
que ese cliente este extendido a la sociedad seleccionada (actualmente 2384).
No alcanza con que el BP exista en el tenant.

- La API consulta todas las paginas de `A_CustomerCompany`, filtradas por
  `CompanyCode`, mediante `S4_BUSINESS_PARTNER_DESTINATION`.
- `GET /api/customer-company-index?companyCode=2384` devuelve las claves Customer
  como texto, conservando ceros iniciales. La lectura es nueva en cada preparacion.
- El frontend cruza CUIT/BP/Customer con ese indice. Si un CUIT tiene varios BP,
  uno ajeno a la sociedad no oculta al cliente de la sociedad seleccionada.
  El log distingue registros sin cliente de clientes no extendidos a la sociedad.
- `POST /api/jobs` vuelve a consultar S/4 y valida todas las filas antes de
  persistir el job o programar escrituras. Si alguna no pertenece a la sociedad,
  rechaza toda la solicitud con HTTP 422; hay que preparar de nuevo el archivo.
- Si la consulta falla, devuelve un error de validacion HTTP 503. Nunca se usa
  un indice parcial ni se continua sin verificar la sociedad.

En este cambio, "habilitado" significa **extendido a la sociedad**. No se agregan
reglas sobre bloqueos de contabilizacion/ventas ni marcas de borrado. Tampoco se
modifican alicuotas, vigencias, categoria IB1, actualizacion/creacion de condiciones
ni la ejecucion en segundo plano existente. La comprobacion de pertenencia se
realiza al iniciar cada job; no bloquea modificaciones posteriores del maestro.

Referencia oficial: [Customer Company — SAP Help](https://help.sap.com/docs/SAP_S4HANA_CLOUD/3c916ef10fc240c9afc594b346ffaf77/3d60045826552246e10000000a441470.html).

### Validacion antes de desplegar

Pruebas locales: `npm test` (incluye paginacion, CUIT compartido entre BP,
exclusiones por sociedad, actualizacion del indice, rechazo antes de cualquier
escritura, errores de conexion/permisos) y `npm run build`.
Usan respuestas simuladas, no datos ni escrituras en S/4.

Solicitar a la funcional un TXT pequeno con el resultado esperado por CUIT:

1. Cliente extendido a 2384: debe entrar.
2. Cliente existente solo en otra sociedad: debe excluirse por sociedad.
3. CUIT sin cliente en ese tenant: debe excluirse por cliente no encontrado.
4. Si esta disponible, cliente extendido a 2384 y a otra sociedad: debe entrar.

Indicar numero de cliente, sociedades, alicuota y vigencia esperadas. Usar casos
conocidos en DEV primero y en TEST despues; los maestros pueden ser distintos.
La consulta `A_CustomerCompany` debe estar disponible para el usuario tecnico de
la destination en cada ambiente. No requiere por si sola nuevos objetos ABAP.
Antes de promover, verificar ese permiso con GET, publicar primero la API y luego
la UI y realizar la prueba pequena antes del TXT masivo.

Este cambio no elimina las limitaciones existentes de memoria del parser del
navegador, el limite de 10 MB del POST ni la falta de un worker durable.
El 27/08/2026 se desplegaron la API y la UI 0.1.4 exclusivamente en DEV.
La API quedo running 1/1, con los destinos y recursos anteriores; el GET del
indice devolvio 30 clientes extendidos a 2384. El repositorio HTML5 confirma
la version 0.1.4. No se ejecutaron padrones ni escrituras de negocio durante
la verificacion tecnica. Queda pendiente la prueba funcional con el TXT pequeno
y los resultados esperados indicados arriba. No se hicieron commit/push ni
cambios en TEST, PRD o ARBA.

Acceso: [CABA DEV](https://padrones-tax-upload-approuter-telefe-dev.cfapps.us10-001.hana.ondemand.com/index.html).

## Seguimiento al reabrir (UI 0.1.5)

Correccion del estado que quedaba detenido visualmente despues de cerrar y
volver a abrir la aplicacion. `onInit` ahora reactiva la consulta periodica del
mismo job, no una sola lectura. No se vuelve a crear ni ejecutar el job.

- Consulta GET sin cache cada 5 segundos, sin solicitudes superpuestas.
- Timeout de 30 segundos para la lectura; los cortes transitorios se reintentan
  y se distinguen de un error del procesamiento. 401/403/404 requieren revisar
  sesion/acceso o la existencia del job; no se presentan como fallo del job.
- Mientras el job siga activo, no se habilita otra carga accidentalmente.
- Al terminar/cerrar/limpiar se cancela el seguimiento de la pantalla. Una
  respuesta tardia no puede reemplazar el estado de un job posterior.
- Se conserva el filtro de clientes extendidos a la sociedad 2384.

Pruebas: seis suites locales, con ocho casos nuevos de seguimiento, y build
correcto. Los casos nuevos usan GET simulado y no realizan escrituras en S/4.
Publicada exclusivamente en DEV el 27/08/2026 a las 18:21:24 GMT, con HTTP 201
y version 0.1.5 confirmada en el app-host. Los archivos descargados del
repositorio HTML5 coinciden con el build probado (SHA-256 de preload,
controlador y manifest). Las seis suites volvieron a pasar y la API responde OK.
El paquete final y publicador estan en BAS dentro de
`/home/user/projects/caba-dev-polling-20260827-v2`. Se elimino solo la clave
temporal de publicacion. No se reinicio ni modifico la API, no se ejecutaron
padrones ni se hicieron cambios en TEST, PRD, ARBA o GitHub.
Pendiente la prueba funcional al cerrar/reabrir durante un job activo; el
AppRouter sigue exigiendo el login existente de TELEFE_BAS.

## Promocion a TEST — 27/08/2026

Despues de la prueba del usuario en DEV, se promovieron a TEST la API con filtro
por sociedad y la UI 0.1.5, usando los mismos ZIP validados, sin reconstruirlos.
La API quedo running 1/1. Se conservaron variables, destinos, rutas, bindings,
memoria de 512 MB y disco de 1 GB. Health OK; el nuevo indice devolvio 1183
clientes extendidos a la sociedad 2384 en TEST.

La UI se publico con HTTP 201 a las 18:42:10 GMT. Version y SHA-256 de preload,
controlador y manifest se verificaron descargando el contenido del app-host TEST.
La API y UI 0.1.3 anteriores se respaldaron en BAS dentro de
`/home/user/projects/caba-test-promotion-20260827`. Se elimino solo la clave
temporal de publicacion. Los ocho jobs anteriores conservan sus IDs y estados;
no se ejecutaron padrones durante esta verificacion. Las seis suites locales
pasaron; el build promovido ya habia pasado las pruebas en DEV.

Acceso: [CABA TEST](https://padrones-tax-upload-approuter-telefe-test.cfapps.us10-001.hana.ondemand.com/index.html).

Pendiente: prueba funcional con TXT pequeno y casos conocidos de pertenencia a
2384/otra sociedad, y cierre/reapertura del seguimiento. Los maestros de TEST
pueden diferir de DEV. No se modificaron DEV, ARBA, PRD, autenticacion ni roles;
no se hicieron commit/push. Se mantienen las limitaciones del parser y worker.

## Arquitectura

- `webapp/`: interfaz SAPUI5 publicada en HTML5 Application Repository.
- `api/`: procesamiento en segundo plano y persistencia del estado del job en S/4.
- `approuter/`: AppRouter recuperado del despliegue DEV.
- `test-approuter/`: AppRouter aislado para TEST.

La API admite destinos por ambiente mediante `S4_BUSINESS_PARTNER_DESTINATION`,
`S4_PRICING_DESTINATION` y `S4_JOBLOG_DESTINATION`. En TEST los tres apuntan al
destino de S/4 Test `S4HANA-BP-I0A`; esto no cambia la configuracion de DEV.
El job log TEST utiliza el servicio publicado por el escenario `ZCS_PADRON_JOBLOG`:
`/sap/opu/odata/sap/ZFI_PADRON_JOBLOG_SRV`.
La API lee `$metadata` al iniciar el store de jobs y resuelve los nombres reales
de las propiedades OData. Esto mantiene compatibilidad con servicios que exponen
campos como `iniciadoEn` o `IniciadoEn` sin cambiar la logica funcional.

## Despliegue TEST

El archivo `manifest-test.yml` crea las aplicaciones con sufijo `-test` y espera
estas instancias de servicio en el space Cloud Foundry TEST:

- `padrones-tax-upload-destination-telefe-test`
- `padrones-tax-upload-xsuaa-telefe-test`
- `padrones-tax-upload-html5-repo-host-telefe-test`
- `padrones-tax-upload-html5-repo-runtime-telefe-test`

La interfaz se publica en la instancia `app-host` y el AppRouter la consume desde
la instancia `app-runtime`. No se deben reutilizar los servicios de DEV.

## Comandos

```sh
npm install
npm test
npm run build
```

El contenido generado para HTML5 Application Repository queda en `dist/`.
