"use strict";

/*
 * Facade de seleccion de store de jobs del padron CABA.
 * Mismo patron que zfi-padron-embargo (joblog-store.js).
 *
 * JOBLOG_STORE=s4 (default) -> persiste en S/4 via OData v2 (s4-joblog-store.js),
 *                              contra el servicio Z propio del padron CABA.
 * JOBLOG_STORE=memory       -> in-memory. Para desarrollo/pruebas mientras el
 *                              servicio Z de S/4 no este disponible. Los jobs se
 *                              pierden al reiniciar la app.
 */

var STORE_IMPL = (process.env.JOBLOG_STORE || "s4").toLowerCase();

module.exports = STORE_IMPL === "memory"
  ? require("./joblog-store-memory")
  : require("./s4-joblog-store");
