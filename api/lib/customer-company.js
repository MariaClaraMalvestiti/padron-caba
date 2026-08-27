"use strict";

const destinationClient = require("./destination");
const ENTITY_PATH = "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerCompany";

class CompanyValidationError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateCompanyCode(value) {
  const companyCode = String(value || "").trim();
  if (!/^\d{4}$/.test(companyCode)) {
    throw new CompanyValidationError("Debe seleccionar una sociedad valida.", 400, "INVALID_COMPANY");
  }
  return companyCode;
}

function nextPagePath(link, currentPath) {
  if (typeof link !== "string" || !link.trim()) {
    throw new Error("Paginacion de clientes invalida.");
  }
  const url = new URL(link, "https://s4.invalid" + currentPath);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== ENTITY_PATH ||
      url.username || url.password || url.hash) {
    throw new Error("Paginacion fuera de A_CustomerCompany.");
  }
  // Nunca se consulta el host del enlace: todas las paginas usan la misma destination.
  return url.pathname + url.search;
}

async function loadCompanyCustomers(destinationName, value, client = destinationClient) {
  const companyCode = validateCompanyCode(value);
  const customers = new Set();
  const visited = new Set();
  let pagePath = ENTITY_PATH + "?$select=Customer,CompanyCode&$filter=" +
    encodeURIComponent("CompanyCode eq '" + companyCode + "'") + "&$format=json";

  try {
    while (pagePath) {
      if (visited.has(pagePath)) {
        throw new Error("Paginacion repetida de A_CustomerCompany.");
      }
      visited.add(pagePath);
      const response = await client.callDestination(destinationName, pagePath, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      const data = await client.readJsonResponse(response, "al consultar clientes por sociedad");
      if (!data || !data.d || !Array.isArray(data.d.results)) {
        throw new Error("Respuesta incompleta de A_CustomerCompany.");
      }
      for (const item of data.d.results) {
        if (!item || item.CompanyCode !== companyCode ||
            typeof item.Customer !== "string" || !item.Customer.trim()) {
          throw new Error("Asignacion de cliente/sociedad invalida.");
        }
        // Mantener ceros iniciales: Customer es una clave, no un numero.
        customers.add(item.Customer.trim());
      }
      pagePath = data.d.__next == null ? "" : nextPagePath(data.d.__next, pagePath);
    }
    return customers;
  } catch (_error) {
    // No devolver respuestas S/4 ni credenciales. Tampoco usar un indice parcial.
    throw new CompanyValidationError(
      "No se pudo validar la asignacion de clientes a la sociedad " + companyCode +
      ". Revisar la conexion y el acceso a A_CustomerCompany en API_BUSINESS_PARTNER. No se inicio el procesamiento.",
      503,
      "COMPANY_VALIDATION_UNAVAILABLE"
    );
  }
}

function assertCustomersInCompany(rows, customers, companyCode) {
  const rejectedCount = rows.filter(function (row) {
    return !row || typeof row.customer !== "string" || !customers.has(row.customer.trim());
  }).length;
  if (rejectedCount) {
    throw new CompanyValidationError(
      "No se inicio el procesamiento: " + rejectedCount +
      " registros no corresponden a clientes extendidos a la sociedad " + companyCode +
      ". Volve a seleccionar el archivo para actualizar el filtro.",
      422,
      "CUSTOMER_NOT_IN_COMPANY"
    );
  }
}

module.exports = { loadCompanyCustomers, assertCustomersInCompany, CompanyValidationError };
