const DEFAULT_SWAGGER_PROXY_PATH = "/api/swagger";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCamelCase(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (index === 0) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

function normalizeMethods(pathConfig) {
  const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"];
  return httpMethods.filter((method) => isObject(pathConfig?.[method]));
}

function normalizeParameterDefaults(parameters) {
  const defaults = {};
  for (const param of parameters) {
    if (param.default !== undefined) {
      defaults[param.name] = param.default;
      continue;
    }
    if (Array.isArray(param.enum) && param.enum.length > 0) {
      defaults[param.name] = param.enum[0];
    }
  }
  return defaults;
}

export class FASApiClient {
  constructor(config = {}) {
    this.proxyBase = config.proxyBase || "/api/fas";
    this.swaggerUrl = config.swaggerUrl || DEFAULT_SWAGGER_PROXY_PATH;
    this.spec = null;
    this.operations = [];
    this.operationIndex = new Map();
    this.endpoints = {};
  }

  async loadSpec() {
    const response = await fetch(this.swaggerUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Unable to load swagger (${response.status} ${response.statusText})`);
    }

    this.spec = await response.json();
    this.operations = this.parseOperations(this.spec);
    this.operationIndex = new Map(this.operations.map((operation) => [operation.id, operation]));
    this.endpoints = this.createBoundMethods(this.operations);
    return this.spec;
  }

  parseOperations(spec) {
    if (!isObject(spec?.paths)) {
      return [];
    }

    const operations = [];

    for (const [pathTemplate, pathConfig] of Object.entries(spec.paths)) {
      const pathParameters = Array.isArray(pathConfig.parameters) ? pathConfig.parameters : [];
      const methods = normalizeMethods(pathConfig);

      for (const method of methods) {
        const operationConfig = pathConfig[method];
        const operationParameters = Array.isArray(operationConfig.parameters) ? operationConfig.parameters : [];
        const parameters = [...pathParameters, ...operationParameters]
          .filter((parameter) => isObject(parameter) && parameter.name && parameter.in)
          .map((parameter) => ({
            ...parameter,
            required: Boolean(parameter.required),
            schemaType: parameter.type || parameter.schema?.type || "string"
          }));

        const id = operationConfig.operationId || `${method.toUpperCase()} ${pathTemplate}`;
        const safeMethodName = toCamelCase(operationConfig.operationId || `${method}_${pathTemplate}`);

        operations.push({
          id,
          safeMethodName,
          method: method.toUpperCase(),
          pathTemplate,
          summary: operationConfig.summary || "",
          description: operationConfig.description || "",
          tags: Array.isArray(operationConfig.tags) ? operationConfig.tags : [],
          produces: Array.isArray(operationConfig.produces)
            ? operationConfig.produces
            : Array.isArray(spec.produces)
              ? spec.produces
              : ["application/json"],
          parameters,
          parameterDefaults: normalizeParameterDefaults(parameters)
        });
      }
    }

    return operations.sort((left, right) => {
      const leftTag = left.tags[0] || "zzz";
      const rightTag = right.tags[0] || "zzz";
      if (leftTag !== rightTag) {
        return leftTag.localeCompare(rightTag);
      }
      if (left.pathTemplate !== right.pathTemplate) {
        return left.pathTemplate.localeCompare(right.pathTemplate);
      }
      return left.method.localeCompare(right.method);
    });
  }

  createBoundMethods(operations) {
    const methods = {};
    const usedNames = new Set();

    for (const operation of operations) {
      let candidate = operation.safeMethodName || "operation";
      if (!candidate) {
        candidate = "operation";
      }

      let uniqueName = candidate;
      let counter = 2;
      while (usedNames.has(uniqueName)) {
        uniqueName = `${candidate}${counter}`;
        counter += 1;
      }

      usedNames.add(uniqueName);

      methods[uniqueName] = async (params = {}, options = {}) => this.callOperation(operation.id, params, options);
      methods[uniqueName].operation = operation;
    }

    return methods;
  }

  getOperationById(operationId) {
    return this.operationIndex.get(operationId) || null;
  }

  listTags() {
    const tagSet = new Set();
    for (const operation of this.operations) {
      if (operation.tags.length === 0) {
        tagSet.add("untagged");
      }
      for (const tag of operation.tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }

  listOperations(filters = {}) {
    const text = String(filters.text || "").trim().toLowerCase();
    const tag = filters.tag || "";

    return this.operations.filter((operation) => {
      if (tag && !(operation.tags.includes(tag) || (tag === "untagged" && operation.tags.length === 0))) {
        return false;
      }

      if (!text) {
        return true;
      }

      const haystack = [
        operation.id,
        operation.summary,
        operation.description,
        operation.pathTemplate,
        operation.method,
        ...(operation.tags || [])
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(text);
    });
  }

  buildPath(operation, params) {
    const missing = [];
    const urlPath = operation.pathTemplate.replace(/\{([^}]+)\}/g, (_, name) => {
      const value = params[name];
      if (value === undefined || value === null || String(value).trim() === "") {
        missing.push(name);
        return `{${name}}`;
      }
      return encodeURIComponent(String(value));
    });

    if (missing.length > 0) {
      throw new Error(`Missing path parameter(s): ${missing.join(", ")}`);
    }

    return `${this.proxyBase}${urlPath.replace(/^\/api/, "")}`;
  }

  buildQueryString(operation, params) {
    const queryPairs = [];

    for (const parameter of operation.parameters) {
      if (parameter.in !== "query") {
        continue;
      }

      const value = params[parameter.name];
      if (value === undefined || value === null || String(value).trim() === "") {
        if (parameter.required) {
          throw new Error(`Missing required query parameter: ${parameter.name}`);
        }
        continue;
      }

      queryPairs.push([parameter.name, String(value)]);
    }

    if (queryPairs.length === 0) {
      return "";
    }

    const query = new URLSearchParams(queryPairs).toString();
    return `?${query}`;
  }

  buildRequest(operation, params = {}) {
    const mergedParams = {
      ...operation.parameterDefaults,
      ...params
    };

    const url = `${this.buildPath(operation, mergedParams)}${this.buildQueryString(operation, mergedParams)}`;

    return {
      url,
      method: operation.method,
      params: mergedParams
    };
  }

  async callOperation(operationId, params = {}, options = {}) {
    const operation = this.getOperationById(operationId);
    if (!operation) {
      throw new Error(`Unknown operation: ${operationId}`);
    }

    const request = this.buildRequest(operation, params);

    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    const responseType = response.headers.get("content-type") || "";
    let payload;

    if (responseType.includes("application/json")) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`API call failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    return {
      operation,
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: payload
      }
    };
  }
}

export function createFASClient(config = {}) {
  return new FASApiClient(config);
}
