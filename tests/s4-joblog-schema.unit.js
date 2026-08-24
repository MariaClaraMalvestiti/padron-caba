"use strict";

const assert = require("assert");
const { buildS4JoblogSchema } = require("../api/lib/s4-joblog-schema");

function metadataWithCase(bUppercase) {
  const names = bUppercase
    ? {
      file: "Archivo", status: "Estado", started: "IniciadoEn", finished: "FinalizadoEn",
      total: "FilasTotales", valid: "FilasValidas", created: "Creadas", updated: "Actualizadas",
      errors: "Errores", message: "Mensaje", user: "CreadoPor", line: "NumeroLinea",
      job: "Job_ID", customer: "Cliente", business: "RazonSocial", action: "Accion",
      result: "Resultado", timestamp: "Timestamp"
    }
    : {
      file: "archivo", status: "estado", started: "iniciadoEn", finished: "finalizadoEn",
      total: "filasTotales", valid: "filasValidas", created: "creadas", updated: "actualizadas",
      errors: "errores", message: "mensaje", user: "creadoPor", line: "numeroLinea",
      job: "job_ID", customer: "cliente", business: "razonSocial", action: "accion",
      result: "resultado", timestamp: "timestamp"
    };

  return `<?xml version="1.0"?><Schema>
    <EntityType Name="JobsSetType"><Key><PropertyRef Name="ID"/></Key>
      <Property Name="ID" Type="Edm.Guid"/><Property Name="${names.file}" Type="Edm.String"/>
      <Property Name="${names.status}" Type="Edm.String"/><Property Name="${names.started}" Type="Edm.DateTime"/>
      <Property Name="${names.finished}" Type="Edm.DateTime"/><Property Name="${names.total}" Type="Edm.Int32"/>
      <Property Name="${names.valid}" Type="Edm.Int32"/><Property Name="${names.created}" Type="Edm.Int32"/>
      <Property Name="${names.updated}" Type="Edm.Int32"/><Property Name="${names.errors}" Type="Edm.Int32"/>
      <Property Name="${names.message}" Type="Edm.String"/><Property Name="${names.user}" Type="Edm.String"/>
    </EntityType>
    <EntityType Name="JobLogEntriesSetType"><Key><PropertyRef Name="ID"/></Key>
      <Property Name="ID" Type="Edm.Guid"/><Property Name="${names.job}" Type="Edm.Guid"/>
      <Property Name="${names.line}" Type="Edm.Int32"/><Property Name="Cuit" Type="Edm.String"/>
      <Property Name="${names.customer}" Type="Edm.String"/><Property Name="${names.business}" Type="Edm.String"/>
      <Property Name="${names.action}" Type="Edm.String"/><Property Name="${names.result}" Type="Edm.String"/>
      <Property Name="${names.message}" Type="Edm.String"/><Property Name="${names.timestamp}" Type="Edm.DateTime"/>
    </EntityType>
    <EntityContainer>
      <EntitySet Name="JobsSet" EntityType="Test.JobsSetType"/>
      <EntitySet Name="JobLogEntriesSet" EntityType="Test.JobLogEntriesSetType"/>
    </EntityContainer>
  </Schema>`;
}

[false, true].forEach(function (bUppercase) {
  const schema = buildS4JoblogSchema(metadataWithCase(bUppercase), "JobsSet", "JobLogEntriesSet");
  assert.strictEqual(schema.jobs.key.name, "ID");
  assert.strictEqual(schema.jobs.key.type, "Edm.Guid");
  assert.strictEqual(schema.jobs.fields.startedAt.name, bUppercase ? "IniciadoEn" : "iniciadoEn");
  assert.strictEqual(schema.jobs.fields.fileName.name, bUppercase ? "Archivo" : "archivo");
  assert.strictEqual(schema.logs.fields.jobId.name, bUppercase ? "Job_ID" : "job_ID");
  assert.strictEqual(schema.logs.fields.lineNumber.name, bUppercase ? "NumeroLinea" : "numeroLinea");
});

console.log("s4-joblog-schema.unit.js: OK");
