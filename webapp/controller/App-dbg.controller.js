sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  const DISPLAY_COMPANY_CODE = "2384";

  const INITIAL_STATE = {
    fileName: "",
    fileContent: "",
    previewLimit: 500,
    rows: [],
    messages: [],
    totalRows: 0,
    validRows: 0,
    warningRows: 0,
    errorRows: 0,
    companyCode: "",
    companyCodes: [],
    loadingCompanyCodes: false,
    busy: false,
    jobId: "",
    jobStatus: "",
    jobStartedAt: "",
    jobFinishedAt: "",
    jobProgress: 0,
    jobProgressText: "",
    jobStatusText: "",
    jobState: "Information",
    jobMessage: ""
  };

  return Controller.extend("padrones.taxupload.controller.App", {
    onInit: function () {
      this._jobPollTimer = null;
      this.getView().setModel(new JSONModel({ ...INITIAL_STATE }), "app");

      // [CABA_COMPANY_SELECTOR]
      this._loadCompanyCodes();

      const sLastJobId = window.localStorage.getItem("padronesLastJobId");

      if (sLastJobId) {
        this.getView().getModel("app").setProperty("/jobId", sLastJobId);
        this.getView().getModel("app").setProperty("/messages", [{
          type: "Information",
          text: "Consultando estado del ultimo job..."
        }]);
        this.getView().getModel("app").setProperty("/jobProgress", 5);
        this.getView().getModel("app").setProperty("/jobProgressText", "Cargando... 5%");
        this.getView().getModel("app").setProperty("/jobStatusText", "Consultando");
        this.getView().getModel("app").setProperty("/jobMessage", "Consultando estado del ultimo job...");

        this._pollJobStatus(sLastJobId);
      }
    },

    _loadCompanyCodes: async function () {
      const oModel = this.getView().getModel("app");

      oModel.setProperty("/loadingCompanyCodes", true);

      try {
        const oResponse = await fetch("/api/company-codes", {
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error(
            "HTTP " + oResponse.status + ": " + await oResponse.text()
          );
        }

        const oData = await oResponse.json();
        const aCompanyCodes = (Array.isArray(oData.companyCodes)
          ? oData.companyCodes.map(function (oCompany) {
              const sCode = String(oCompany.companyCode || "");
              const sName = String(oCompany.companyCodeName || "");

              return {
                companyCode: sCode,
                companyCodeName: sName,
                displayText: sCode + (sName ? " - " + sName : "")
              };
            })
          : []).filter(function (oCompany) {
            return oCompany.companyCode === DISPLAY_COMPANY_CODE;
          });

        oModel.setProperty("/companyCodes", aCompanyCodes);

        if (aCompanyCodes.length === 1) {
          oModel.setProperty(
            "/companyCode",
            aCompanyCodes[0].companyCode
          );
        }
      } catch (oError) {
        oModel.setProperty("/companyCodes", []);
        oModel.setProperty("/companyCode", "");
        MessageBox.error(
          "No se pudieron obtener las sociedades: " +
          (oError.message || oError)
        );
      } finally {
        oModel.setProperty("/loadingCompanyCodes", false);
      }
    },

    onExit: function () {
      this._stopJobPolling();
    },

    onFileChange: function (oEvent) {
      const aFiles = oEvent.getParameter("files");
      const oFile = aFiles && aFiles[0];

      if (!oFile) {
        return;
      }

      if (!/\.(txt|csv)$/i.test(oFile.name)) {
        MessageBox.error("El archivo debe ser TXT o CSV.");
        this.byId("fileUploader").clear();
        return;
      }

      const oReader = new FileReader();

      oReader.onload = function (oLoadEvent) {
        const sContent = oLoadEvent.target.result || "";
        const oModel = this.getView().getModel("app");
        const sCompanyCode = oModel.getProperty("/companyCode");
        const aCompanyCodes = oModel.getProperty("/companyCodes") || [];

        this._stopJobPolling();

        oModel.setData({
          ...INITIAL_STATE,
          companyCode: sCompanyCode,
          companyCodes: aCompanyCodes
        });
        oModel.setProperty("/fileName", oFile.name);
        oModel.setProperty("/fileContent", sContent);

        this._parseContent();
      }.bind(this);

      oReader.onerror = function () {
        MessageBox.error("No se pudo leer el archivo seleccionado.");
      };

      oReader.readAsText(oFile, "UTF-8");
    },

    onReparse: function () {
      const sContent = this.getView().getModel("app").getProperty("/fileContent");

      if (sContent) {
        this._parseContent();
      }
    },

    onPrepareUpload: async function () {
      const oModel = this.getView().getModel("app");
      const aRows = oModel.getProperty("/rows") || [];
      const sFileName = oModel.getProperty("/fileName");
      const iTotalRows = oModel.getProperty("/totalRows");
      const sCompanyCode = String(
        oModel.getProperty("/companyCode") || ""
      );

      if (!sCompanyCode) {
        MessageBox.warning("Debe seleccionar una sociedad.");
        return;
      }

      if (!aRows.length) {
        MessageBox.warning("No hay registros validos para procesar.");
        return;
      }

      MessageBox.confirm(
        "Se van a enviar " + aRows.length + " registros filtrados para procesarlos en segundo plano. Podras cerrar la pestana y el job seguira corriendo. Continuar?",
        {
          onClose: async function (sAction) {
            if (sAction !== MessageBox.Action.OK) {
              return;
            }

            await this._startBackgroundJob(
              sFileName,
              iTotalRows,
              aRows,
              sCompanyCode
            );
          }.bind(this)
        }
      );
    },

    onClear: function () {
      const oModel = this.getView().getModel("app");
      const sCompanyCode = oModel.getProperty("/companyCode");
      const aCompanyCodes = oModel.getProperty("/companyCodes") || [];

      this._stopJobPolling();
      window.localStorage.removeItem("padronesLastJobId");

      oModel.setData({
        ...INITIAL_STATE,
        companyCode: sCompanyCode,
        companyCodes: aCompanyCodes
      });

      this.byId("fileUploader").clear();
      MessageToast.show("Carga limpiada");
    },

    _parseContent: async function () {
      const oModel = this.getView().getModel("app");
      const sContent = oModel.getProperty("/fileContent") || "";
      const aRawLines = sContent.split(/\r?\n/).filter(function (sLine) {
        return sLine.trim().length > 0;
      });
      const aParsedRows = [];
      const aMessages = [];
      let iInitialValidRows = 0;
      let iWarningRows = 0;
      let iErrorRows = 0;

      oModel.setProperty("/busy", true);
      oModel.setProperty("/rows", []);
      oModel.setProperty("/messages", [{
        type: "Information",
        text: "Validando archivo y filtrando CUITs contra Business Partner..."
      }]);

      aRawLines.forEach(function (sLine, iIndex) {
        const iLineNumber = iIndex + 1;
        const aColumns = this._splitLine(sLine);
        const oRow = this._mapColumns(aColumns, iLineNumber);

        if (oRow.statusState === "Success") {
          iInitialValidRows += 1;
        } else if (oRow.statusState === "Warning") {
          iWarningRows += 1;
        } else {
          iErrorRows += 1;

          if (aMessages.length < 100) {
            aMessages.push({
              type: "Error",
              text: "Linea " + iLineNumber + ": " + oRow.statusText
            });
          }
        }

        aParsedRows.push(oRow);
      }.bind(this));

      if (!aRawLines.length) {
        aMessages.push({
          type: "Warning",
          text: "El archivo no contiene lineas de datos para procesar."
        });
      }

      try {
        const oBpByCuit = await this._loadBusinessPartnerIndex();

        const aValidRowsInClient = aParsedRows.filter(function (oRow) {
          const oBpData = oBpByCuit.get(this._normalizeCuit(oRow.cuit));

          if (oRow.statusState !== "Success" || !oBpData || !oBpData.customer) {
            return false;
          }

          oRow.businessPartner = oBpData.businessPartner;
          oRow.customer = oBpData.customer;
          return true;
        }.bind(this));

        const iRemovedRows = iInitialValidRows - aValidRowsInClient.length;

        if (iRemovedRows > 0) {
          aMessages.unshift({
            type: "Information",
            text: "Se eliminaron " + iRemovedRows + " registros porque su CUIT no existe como Business Partner del cliente."
          });
        }

        aMessages.unshift({
          type: "Information",
          text: "Archivo filtrado correctamente. Registros listos para procesar: " + aValidRowsInClient.length + "."
        });

        oModel.setProperty("/rows", aValidRowsInClient);
        oModel.setProperty("/messages", aMessages);
        oModel.setProperty("/totalRows", aRawLines.length);
        oModel.setProperty("/validRows", aValidRowsInClient.length);
        oModel.setProperty("/warningRows", iWarningRows);
        oModel.setProperty("/errorRows", iErrorRows);
      } catch (oError) {
        oModel.setProperty("/rows", []);
        oModel.setProperty("/messages", [{
          type: "Error",
          text: "No se pudieron recuperar los Business Partners desde API_BUSINESS_PARTNER. " + (oError.message || "")
        }]);
        oModel.setProperty("/totalRows", aRawLines.length);
        oModel.setProperty("/validRows", 0);
        oModel.setProperty("/warningRows", iWarningRows);
        oModel.setProperty("/errorRows", iErrorRows);

        MessageBox.error("No se pudieron recuperar los Business Partners desde API_BUSINESS_PARTNER.");
      } finally {
        oModel.setProperty("/busy", false);
      }
    },

    _loadBusinessPartnerIndex: async function () {
      const oBpByCuit = new Map();
      const oCustomerByBp = new Map();

      let sTaxUrl = "/s4/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartnerTaxNumber?$select=BusinessPartner,BPTaxNumber,BPTaxLongNumber&$format=json";

      while (sTaxUrl) {
        const oResponse = await fetch(sTaxUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar A_BusinessPartnerTaxNumber");
        }

        const oData = await oResponse.json();
        const aResults = oData && oData.d && oData.d.results ? oData.d.results : [];

        aResults.forEach(function (oItem) {
          [oItem.BPTaxNumber, oItem.BPTaxLongNumber].forEach(function (sValue) {
            const sCuit = this._normalizeCuit(sValue);

            if (sCuit.length === 11) {
              oBpByCuit.set(sCuit, {
                businessPartner: oItem.BusinessPartner,
                customer: ""
              });
            }
          }.bind(this));
        }.bind(this));

        sTaxUrl = oData && oData.d && oData.d.__next
          ? oData.d.__next.replace(/^https?:\/\/[^/]+/, "/s4")
          : "";
      }

      let sBpUrl = "/s4/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$select=BusinessPartner,Customer&$format=json";

      while (sBpUrl) {
        const oResponse = await fetch(sBpUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar A_BusinessPartner");
        }

        const oData = await oResponse.json();
        const aResults = oData && oData.d && oData.d.results ? oData.d.results : [];

        aResults.forEach(function (oItem) {
          if (oItem.Customer) {
            oCustomerByBp.set(oItem.BusinessPartner, oItem.Customer);
          }
        });

        sBpUrl = oData && oData.d && oData.d.__next
          ? oData.d.__next.replace(/^https?:\/\/[^/]+/, "/s4")
          : "";
      }

      oBpByCuit.forEach(function (oValue) {
        oValue.customer = oCustomerByBp.get(oValue.businessPartner) || "";
      });

      return oBpByCuit;
    },

    _startBackgroundJob: async function (
      sFileName,
      iTotalRows,
      aRows,
      sCompanyCode
    ) {
      const oModel = this.getView().getModel("app");

      this._stopJobPolling();

      oModel.setProperty("/busy", true);
      oModel.setProperty("/messages", [{
        type: "Information",
        text: "Enviando registros filtrados para procesamiento en segundo plano..."
      }]);

      try {
        const oResponse = await fetch("/api/jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fileName: sFileName,
            totalRows: iTotalRows,
            companyCode: sCompanyCode,
            rows: aRows
          })
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al crear job: " + await oResponse.text());
        }

        const oJob = await oResponse.json();

        oModel.setProperty("/jobId", oJob.id);
        oModel.setProperty("/jobStatus", oJob.status);
        window.localStorage.setItem("padronesLastJobId", oJob.id);
        oModel.setProperty("/jobStartedAt", oJob.startedAt || "");
        oModel.setProperty("/jobProgress", 5);
        oModel.setProperty("/jobProgressText", "Cargando... 5%");
        oModel.setProperty("/jobStatusText", "En proceso");
        oModel.setProperty("/jobState", "Information");
        oModel.setProperty("/jobMessage", "Job creado. El procesamiento continuara aunque cierres la pestana.");
        oModel.setProperty("/messages", [{
          type: "Information",
          text: "Job en proceso. ID: " + oJob.id + ". Inicio: " + this._formatDateTime(oJob.startedAt)
        }]);

        this._startJobPolling(oJob.id);
      } catch (oError) {
        oModel.setProperty("/busy", false);
        oModel.setProperty("/messages", [{
          type: "Error",
          text: "No se pudo iniciar el job. " + (oError.message || oError)
        }]);
        MessageBox.error("No se pudo iniciar el job de procesamiento.");
      }
    },

    _startJobPolling: function (sJobId) {
      this._pollJobStatus(sJobId);

      this._jobPollTimer = setInterval(function () {
        this._pollJobStatus(sJobId);
      }.bind(this), 5000);
    },

    _stopJobPolling: function () {
      if (this._jobPollTimer) {
        clearInterval(this._jobPollTimer);
        this._jobPollTimer = null;
      }
    },

    _pollJobStatus: async function (sJobId) {
      const oModel = this.getView().getModel("app");

      try {
        const oResponse = await fetch("/api/jobs/" + encodeURIComponent(sJobId), {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar job: " + await oResponse.text());
        }

        const oJob = await oResponse.json();
        const bFinished = this._isTerminalJobStatus(oJob.status);
        const iTotalRows = Number(
          oJob.totalRows ||
          oJob.TotalRows ||
          oModel.getProperty("/totalRows") ||
          0
        );
        const iProgress = this._calculateJobProgress(oJob);

        oModel.setProperty("/jobId", oJob.id || sJobId);
        oModel.setProperty("/jobStatus", oJob.status || "");
        oModel.setProperty("/jobStartedAt", oJob.startedAt || "");
        oModel.setProperty("/jobFinishedAt", oJob.finishedAt || "");
        oModel.setProperty("/totalRows", iTotalRows);
        oModel.setProperty("/validRows", oJob.validRows || oModel.getProperty("/validRows") || 0);
        oModel.setProperty("/errorRows", oJob.errorCount || 0);
        oModel.setProperty("/jobProgress", iProgress);
        oModel.setProperty("/jobProgressText", this._buildProgressText(oJob.status, iProgress));
        oModel.setProperty("/jobStatusText", this._formatJobStatus(oJob.status));
        oModel.setProperty("/jobState", this._jobValueState(oJob.status));
        oModel.setProperty("/jobMessage", oJob.message || "Procesamiento en segundo plano.");
        oModel.setProperty("/messages", [this._buildJobMessage(oJob)]);

        if (bFinished) {
          this._stopJobPolling();
          oModel.setProperty("/busy", false);

          if (oJob.status === "FINALIZADO") {
            MessageBox.success(oJob.message || "Job finalizado correctamente.");
          } else if (oJob.status === "FINALIZADO_CON_ERRORES") {
            MessageBox.warning(oJob.message || "Job finalizado con errores.");
          } else {
            MessageBox.error(oJob.message || "El job finalizo con error.");
          }
        }
      } catch (oError) {
        this._stopJobPolling();
        oModel.setProperty("/busy", false);
        oModel.setProperty("/jobStatusText", "Error de consulta");
        oModel.setProperty("/jobState", "Error");
        oModel.setProperty("/jobMessage", "No se pudo consultar el estado del job. " + (oError.message || oError));
        oModel.setProperty("/messages", [{
          type: "Error",
          text: "No se pudo consultar el estado del job. " + (oError.message || oError)
        }]);
      }
    },

    _isTerminalJobStatus: function (sStatus) {
      return sStatus === "FINALIZADO" ||
        sStatus === "FINALIZADO_CON_ERRORES" ||
        sStatus === "ERROR";
    },

    _calculateJobProgress: function (oJob) {
      if (this._isTerminalJobStatus(oJob.status)) {
        return 100;
      }

      const sMessage = String(oJob.message || "");
      const aMatch = sMessage.match(/(?:Procesando|Procesado|Error en)\s+(\d+)\s*\/\s*(\d+)/i);

      if (aMatch) {
        const iProcessed = Number(aMatch[1]);
        const iTotal = Number(aMatch[2]);

        if (iTotal > 0) {
          return Math.max(1, Math.min(99, Math.round(iProcessed * 100 / iTotal)));
        }
      }

      return oJob.status === "EN_PROCESO" ? 5 : 0;
    },

    _buildProgressText: function (sStatus, iProgress) {
      if (sStatus === "FINALIZADO") {
        return "Finalizado";
      }

      if (sStatus === "FINALIZADO_CON_ERRORES") {
        return "Finalizado con errores";
      }

      if (sStatus === "ERROR") {
        return "Error";
      }

      return "Cargando... " + iProgress + "%";
    },

    _formatJobStatus: function (sStatus) {
      const oLabels = {
        EN_PROCESO: "En proceso",
        FINALIZADO: "Finalizado",
        FINALIZADO_CON_ERRORES: "Finalizado con errores",
        ERROR: "Error"
      };

      return oLabels[sStatus] || sStatus || "Consultando";
    },

    _jobValueState: function (sStatus) {
      if (sStatus === "FINALIZADO") {
        return "Success";
      }

      if (sStatus === "FINALIZADO_CON_ERRORES") {
        return "Warning";
      }

      if (sStatus === "ERROR") {
        return "Error";
      }

      return "Information";
    },

    _buildJobMessage: function (oJob) {
      const sStatus = oJob.status || "";
      const sStartedAt = this._formatDateTime(oJob.startedAt);
      const sFinishedAt = this._formatDateTime(oJob.finishedAt);
      const sMessage = oJob.message || "";

      if (sStatus === "EN_PROCESO") {
        return {
          type: "Information",
          text: (sMessage || "Job en proceso.") + " Inicio: " + sStartedAt
        };
      }

      if (sStatus === "FINALIZADO") {
        return {
          type: "Success",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      if (sStatus === "FINALIZADO_CON_ERRORES") {
        return {
          type: "Warning",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      if (sStatus === "ERROR") {
        return {
          type: "Error",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      return {
        type: "Information",
        text: "Estado del job: " + sStatus
      };
    },

    _formatDateTime: function (sValue) {
      if (!sValue) {
        return "-";
      }

      const oDate = new Date(sValue);

      if (isNaN(oDate.getTime())) {
        return sValue;
      }

      return oDate.toLocaleString("es-AR");
    },

    _splitLine: function (sLine) {
      return sLine.split(";").map(function (sValue) {
        return sValue.trim().replace(/^"|"$/g, "");
      });
    },

    _mapColumns: function (aColumns, iLineNumber) {
      // [CABA_PADRON_P_PREFIX] El formato con registro P agrega una columna inicial.
      const iOffset = String(aColumns[0] || "").toUpperCase() === "P" ? 1 : 0;
      const oRow = {
        line: iLineNumber,
        validFrom: this._formatSourceDate(aColumns[1 + iOffset] || ""),
        validTo: this._formatSourceDate(aColumns[2 + iOffset] || ""),
        cuit: this._formatCuit(aColumns[3 + iOffset] || ""),
        rate: aColumns[7 + iOffset] || "",
        customer: "",
        businessPartner: ""
      };
      const aErrors = [];

      if (!this._isValidCuit(oRow.cuit)) {
        aErrors.push("CUIT invalido o faltante");
      }

      if (!this._isValidRate(oRow.rate)) {
        aErrors.push("alicuota de percepcion invalida");
      }

      if (!this._isValidSourceDate(aColumns[1]) || !this._isValidSourceDate(aColumns[2])) {
        aErrors.push("vigencia invalida");
      }

      if (aColumns.length < 8 + iOffset) {
        aErrors.push("faltan columnas del formato ARDJU");
      }

      if (aErrors.length) {
        oRow.statusState = "Error";
        oRow.statusText = aErrors.join(", ");
      } else {
        oRow.statusState = "Success";
        oRow.statusText = "Listo";
      }

      return oRow;
    },

    _isValidCuit: function (sValue) {
      return /^\d{2}-?\d{8}-?\d$/.test((sValue || "").trim());
    },

    _isValidRate: function (sValue) {
      const sNormalized = this._normalizeRate(sValue);
      const fRate = Number(sNormalized);

      return Number.isFinite(fRate) && fRate >= 0 && fRate <= 100;
    },

    _isValidSourceDate: function (sValue) {
      return /^\d{8}$/.test((sValue || "").trim());
    },

    _formatSourceDate: function (sValue) {
      const sDate = (sValue || "").trim();

      if (!this._isValidSourceDate(sDate)) {
        return sDate;
      }

      return sDate.slice(0, 2) + "." + sDate.slice(2, 4) + "." + sDate.slice(4, 8);
    },

    _formatCuit: function (sValue) {
      const sCuit = this._normalizeCuit(sValue);

      if (sCuit.length !== 11) {
        return sValue;
      }

      return sCuit.slice(0, 2) + "-" + sCuit.slice(2, 10) + "-" + sCuit.slice(10);
    },

    _normalizeCuit: function (sValue) {
      return (sValue || "").replace(/\D/g, "");
    },

    _normalizeRate: function (sValue) {
      return String(sValue || "").replace("%", "").replace(",", ".").trim();
    }
  });
});
