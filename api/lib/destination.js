"use strict";

/*
 * Helpers de conectividad via SAP Destination Service.
 * Extraidos de server.js para poder compartirlos con los stores de jobs
 * (lib/s4-joblog-store.js) sin duplicar logica.
 */

const HTTP_TIMEOUT_MS = 60000;

function getBoundServiceByLabel(label, fallbackName) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
  const services = Object.values(vcap).flat();

  return services.find(function (service) {
    return service.label === label || service.name === fallbackName;
  });
}

function getDestinationCredentials() {
  const destination = getBoundServiceByLabel("destination", "padrones-tax-upload-destination");

  if (!destination || !destination.credentials) {
    throw new Error("No se encontraron credenciales de Destination Service en VCAP_SERVICES.");
  }

  return destination.credentials;
}

function getDestinationToken() {
  const credentials = getDestinationCredentials();
  const tokenUrl = credentials.url + "/oauth/token";

  return fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(credentials.clientid + ":" + credentials.clientsecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  }).then(async function (response) {
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " al obtener token de Destination Service: " + await response.text());
    }

    const data = await response.json();
    return data.access_token;
  });
}

async function getDestination(name) {
  const credentials = getDestinationCredentials();
  const token = await getDestinationToken();
  const url = credentials.uri + "/destination-configuration/v1/destinations/" + encodeURIComponent(name);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al leer destination " + name + ": " + await response.text());
  }

  return response.json();
}

async function callDestination(destinationName, path, options) {
  const destination = await getDestination(destinationName);
  const config = destination.destinationConfiguration || {};
  const targetUrl = (config.URL || config.Url || config.url || "").replace(/\/$/, "") + path;
  const headers = Object.assign({}, options && options.headers ? options.headers : {});
  const method = options && options.method ? options.method : "GET";
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : HTTP_TIMEOUT_MS;

  if (destination.authTokens && destination.authTokens.length) {
    headers.Authorization = destination.authTokens[0].type + " " + destination.authTokens[0].value;
  } else if (config.User && config.Password) {
    headers.Authorization = "Basic " + Buffer.from(config.User + ":" + config.Password).toString("base64");
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(targetUrl, {
      method: method,
      headers: headers,
      body: options && options.body ? options.body : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Timeout de " + timeoutMs + "ms llamando " + destinationName + " " + method + " " + path);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, errorContext) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " " + errorContext + ": " + text);
  }

  return text ? JSON.parse(text) : {};
}

function getResponseCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function toCookieHeader(cookies) {
  return cookies.map(function (cookie) {
    return cookie.split(";")[0];
  }).join("; ");
}

async function fetchCsrfToken(destinationName, servicePath) {
  const response = await callDestination(destinationName, servicePath, {
    headers: {
      "X-CSRF-Token": "Fetch",
      "Accept": "application/json"
    }
  });

  const token = response.headers.get("x-csrf-token");
  const cookieHeader = toCookieHeader(getResponseCookies(response));

  if (!response.ok || !token) {
    throw new Error("No se pudo obtener CSRF token para " + servicePath + ": " + await response.text());
  }

  return {
    token: token,
    cookie: cookieHeader
  };
}

module.exports = {
  getBoundServiceByLabel: getBoundServiceByLabel,
  getDestinationCredentials: getDestinationCredentials,
  callDestination: callDestination,
  readJsonResponse: readJsonResponse,
  fetchCsrfToken: fetchCsrfToken
};
