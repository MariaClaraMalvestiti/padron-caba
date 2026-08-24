"use strict";

const JOB_FIELD_CANDIDATES = {
  fileName: ["archivo", "fileName", "FileName"],
  status: ["estado", "status", "Status"],
  startedAt: ["iniciadoEn", "startedAt", "StartedAt", "CreatedAt"],
  finishedAt: ["finalizadoEn", "finishedAt", "FinishedAt"],
  totalRows: ["filasTotales", "totalRows", "TotalRows"],
  validRows: ["filasValidas", "validRows", "ValidRows", "FoundRows"],
  createdCount: ["creadas", "createdCount", "CreatedCount", "CreateCount"],
  updatedCount: ["actualizadas", "updatedCount", "UpdatedCount", "UpdateCount"],
  errorCount: ["errores", "errorCount", "ErrorCount"],
  message: ["mensaje", "message", "Message"],
  createdBy: ["creadoPor", "createdBy", "CreatedBy"]
};

const LOG_FIELD_CANDIDATES = {
  jobId: ["job_ID", "jobId", "JobId", "Job_ID", "JobID"],
  lineNumber: ["numeroLinea", "lineNumber", "LineNumber"],
  cuit: ["cuit", "Cuit", "CUIT"],
  customer: ["cliente", "customer", "Customer"],
  businessName: ["razonSocial", "businessName", "BusinessName"],
  action: ["accion", "action", "Action"],
  result: ["resultado", "result", "Result"],
  message: ["mensaje", "message", "Message"],
  timestamp: ["timestamp", "Timestamp", "createdAt", "CreatedAt"]
};

function readAttribute(sTag, sName) {
  const oMatch = new RegExp("\\b" + sName + "=\"([^\"]+)\"", "i").exec(sTag || "");
  return oMatch ? oMatch[1] : null;
}

function normalizeName(sName) {
  return String(sName || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function parseProperties(sEntityBlock) {
  const oProperties = {};
  const aTags = String(sEntityBlock || "").match(/<Property\b[^>]*>/gi) || [];

  aTags.forEach(function (sTag) {
    const sName = readAttribute(sTag, "Name");
    if (sName) {
      oProperties[sName] = {
        name: sName,
        type: readAttribute(sTag, "Type") || ""
      };
    }
  });

  return oProperties;
}

function findEntityTypeName(sMetadata, sEntitySetName) {
  const aTags = String(sMetadata || "").match(/<EntitySet\b[^>]*>/gi) || [];
  const sTag = aTags.find(function (sCandidate) {
    return readAttribute(sCandidate, "Name") === sEntitySetName;
  });

  if (!sTag) {
    return null;
  }

  const sQualifiedName = readAttribute(sTag, "EntityType") || "";
  return sQualifiedName.split(".").pop() || null;
}

function findEntityTypeBlock(sMetadata, sTypeName) {
  const aBlocks = String(sMetadata || "").match(/<EntityType\b[^>]*>[\s\S]*?<\/EntityType>/gi) || [];
  return aBlocks.find(function (sBlock) {
    const sOpeningTag = (sBlock.match(/^<EntityType\b[^>]*>/i) || [""])[0];
    return readAttribute(sOpeningTag, "Name") === sTypeName;
  }) || null;
}

function findProperty(oProperties, aCandidates) {
  const aNames = Object.keys(oProperties || {});

  for (const sCandidate of aCandidates || []) {
    if (Object.prototype.hasOwnProperty.call(oProperties, sCandidate)) {
      return oProperties[sCandidate];
    }
  }

  for (const sCandidate of aCandidates || []) {
    const sNormalizedCandidate = normalizeName(sCandidate);
    const sFoundName = aNames.find(function (sName) {
      return normalizeName(sName) === sNormalizedCandidate;
    });

    if (sFoundName) {
      return oProperties[sFoundName];
    }
  }

  return null;
}

function parseEntitySchema(sMetadata, sEntitySetName, oCandidates) {
  const sTypeName = findEntityTypeName(sMetadata, sEntitySetName);
  const sBlock = findEntityTypeBlock(sMetadata, sTypeName);

  if (!sTypeName || !sBlock) {
    return null;
  }

  const oProperties = parseProperties(sBlock);
  const sKeyName = readAttribute((sBlock.match(/<PropertyRef\b[^>]*>/i) || [""])[0], "Name");
  const oKey = sKeyName && oProperties[sKeyName] ? oProperties[sKeyName] : null;
  const oFields = {};

  Object.keys(oCandidates || {}).forEach(function (sInternalName) {
    oFields[sInternalName] = findProperty(oProperties, oCandidates[sInternalName]);
  });

  return {
    entitySet: sEntitySetName,
    entityType: sTypeName,
    key: oKey,
    fields: oFields,
    properties: oProperties
  };
}

function buildS4JoblogSchema(sMetadata, sJobsEntitySet, sLogsEntitySet) {
  const oJobs = parseEntitySchema(sMetadata, sJobsEntitySet, JOB_FIELD_CANDIDATES);

  if (!oJobs || !oJobs.key) {
    throw new Error("No se pudo resolver el esquema OData de " + sJobsEntitySet + ".");
  }

  return {
    jobs: oJobs,
    logs: parseEntitySchema(sMetadata, sLogsEntitySet, LOG_FIELD_CANDIDATES)
  };
}

module.exports = {
  buildS4JoblogSchema: buildS4JoblogSchema
};
