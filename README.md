# Padron CABA

Aplicacion SAPUI5 desplegada en SAP BTP para procesar el padron de percepciones de CABA.

## Estado de la recuperacion

La etiqueta `recovery-0.1.2` conserva exactamente la interfaz recuperada desde HTML5 Application Repository el 24/08/2026.

La rama `main` contiene el proyecto fuente reconstruido. La version 0.1.3 incorpora:

- filtro exclusivamente visual para mostrar la sociedad 2384;
- estado persistente del job al volver a ingresar;
- barra de progreso calculada desde los mensajes persistidos por el backend.

La logica funcional y los endpoints del backend no se modifican con estos cambios.

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
