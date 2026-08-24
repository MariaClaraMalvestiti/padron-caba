# Padron CABA

Aplicacion SAPUI5 desplegada en SAP BTP para procesar el padron de percepciones de CABA.

## Estado de la recuperacion

La etiqueta `recovery-0.1.2` conserva exactamente la interfaz recuperada desde HTML5 Application Repository el 24/08/2026.

La rama `main` contiene el proyecto fuente reconstruido. La version 0.1.3 incorpora:

- filtro exclusivamente visual para mostrar la sociedad 2384;
- estado persistente del job al volver a ingresar;
- barra de progreso calculada desde los mensajes persistidos por el backend.

La logica y los endpoints del backend no se modifican con estos cambios.

## Comandos

```sh
npm install
npm test
npm run build
```

El contenido generado para HTML5 Application Repository queda en `dist/`.

