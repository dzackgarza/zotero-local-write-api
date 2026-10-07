import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

// Parse openapi.yaml with a minimal YAML parser (js-yaml is already
// available as a transitive dependency of redocly).
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const OPENAPI_PATH = path.join(REPO_ROOT, "openapi.yaml");
const CONFIG_PATH = path.join(REPO_ROOT, "config.yml");
const VERSION_PATH = path.join(REPO_ROOT, "VERSION");

// ── Helpers ────────────────────────────────────────────────────

// Every add-on source module that esbuild bundles into bootstrap.js. The
// generated OpenAPI types and the ambient declarations hold no handlers.
function parseSources(): ts.SourceFile[] {
  return fs
    .readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) =>
      ts.createSourceFile(
        name,
        fs.readFileSync(path.join(SRC_DIR, name), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    );
}

// Minimal structural view of the parts of the spec these tests navigate.
// The YAML is dynamic, but every access below is covered by this shape.
// Fields are declared required: this is the shape each test asserts the spec
// has. If a field is actually absent, the navigation throws at runtime, which
// is the failure the test is meant to surface.
interface SchemaNode {
  $ref: string;
  const: string;
  required: string[];
  oneOf: SchemaNode[];
  allOf: SchemaNode[];
  properties: Record<string, SchemaNode>;
  discriminator: { mapping: Record<string, string> };
}

interface OpenAPIDoc {
  info: { version: string };
  servers: { url: string }[];
  paths: Record<string, unknown>;
  components: { schemas: Record<string, SchemaNode> };
}

interface ConfigDoc {
  endpoints: Record<string, string>;
}

function parseOpenAPI(): OpenAPIDoc {
  const source = fs.readFileSync(OPENAPI_PATH, "utf8");
  return yaml.load(source) as OpenAPIDoc;
}

function parseConfig(): ConfigDoc {
  const source = fs.readFileSync(CONFIG_PATH, "utf8");
  return yaml.load(source) as ConfigDoc;
}

// The object literal a declaration initializes, when the declaration is writeHandlers
function writeHandlersTable(declaration: ts.VariableDeclaration): ts.ObjectLiteralExpression[] {
  const initializer = declaration.initializer;
  const isNamed = ts.isIdentifier(declaration.name) && declaration.name.text === "writeHandlers";
  return isNamed && initializer !== undefined && ts.isObjectLiteralExpression(initializer)
    ? [initializer]
    : [];
}

// Find the writeHandlers table that runWrite dispatches through
function findWriteHandlers(sources: ts.SourceFile[]): ts.ObjectLiteralExpression {
  const tables = sources
    .flatMap((source) => [...source.statements])
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations.flatMap(writeHandlersTable));
  if (tables.length !== 1) {
    throw new Error(`Expected one writeHandlers object literal in src/, found ${tables.length}`);
  }
  return tables[0];
}

// Find the one top-level declaration of a handler across the source modules
function findHandler(sources: ts.SourceFile[], handlerName: string): ts.Statement {
  const found = sources
    .flatMap((source) => [...source.statements])
    .filter(
      (statement) =>
        (ts.isFunctionDeclaration(statement) && statement.name?.text === handlerName) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (d) => ts.isIdentifier(d.name) && d.name.text === handlerName,
          )),
    );
  if (found.length !== 1) {
    throw new Error(
      `Expected one top-level declaration of handler "${handlerName}" in src/, found ${found.length}`,
    );
  }
  return found[0];
}

// Extract each operation name and the handler it dispatches to
function extractWriteHandlers(
  table: ts.ObjectLiteralExpression,
): { op: string; handlerName: string }[] {
  return table.properties.map((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      !ts.isIdentifier(property.initializer)
    ) {
      throw new Error(
        `writeHandlers entry is not \`operation: handlerName\`: ${property.getText()}`,
      );
    }
    return { op: property.name.text, handlerName: property.initializer.text };
  });
}

// Find the handler function and extract data.<field> reads
function extractHandlerFields(sources: ts.SourceFile[], handlerName: string): string[] {
  const fields = new Set<string>();
  // Walk the handler body and find all data.<field> property accesses
  function walkForData(n: ts.Node) {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "data"
    ) {
      fields.add(n.name.text);
    }
    ts.forEachChild(n, walkForData);
  }
  ts.forEachChild(findHandler(sources, handlerName), walkForData);
  return [...fields].sort();
}

// Find the first string argument to successResult() in a handler
function extractSuccessOperation(sources: ts.SourceFile[], handlerName: string): string | null {
  let result: string | null = null;
  const handler = findHandler(sources, handlerName);
  if (!ts.isFunctionDeclaration(handler)) {
    return result;
  }
  function findSuccessCall(n: ts.Node) {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "successResult"
    ) {
      const firstArg = n.arguments.at(0);
      if (firstArg && ts.isStringLiteral(firstArg)) {
        result = firstArg.text;
      }
      return;
    }
    ts.forEachChild(n, findSuccessCall);
  }
  findSuccessCall(handler);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────

describe("OpenAPI contract conformance", () => {
  const sources = parseSources();
  const spec = parseOpenAPI();
  const config = parseConfig();
  const version = fs.readFileSync(VERSION_PATH, "utf8").trim();

  const runtimeCases = extractWriteHandlers(findWriteHandlers(sources));
  const runtimeOps = runtimeCases.map((c) => c.op);

  it("runtime dispatches each operation once", () => {
    expect(new Set(runtimeOps).size).toBe(runtimeOps.length);
  });

  it("dispatch table matches WriteRequest discriminator mapping keys", () => {
    const writeReq = spec.components.schemas.WriteRequest;
    const mappingKeys = Object.keys(writeReq.discriminator.mapping);
    expect(new Set(mappingKeys)).toEqual(new Set(runtimeOps));
  });

  it("dispatch table matches WriteRequest oneOf refs", () => {
    const writeReq = spec.components.schemas.WriteRequest;
    const oneOfRefs = writeReq.oneOf.map((s) => s.$ref.split("/").pop()!);
    expect(oneOfRefs.length).toBe(runtimeOps.length);
    // Each ref should point to a schema whose operation const matches a runtime op
    for (const ref of oneOfRefs) {
      const schema = spec.components.schemas[ref];
      expect(schema).toBeDefined();
      const constVal = schema.properties.operation.const;
      expect(runtimeOps).toContain(constVal);
    }
  });

  it("dispatch table matches WriteSuccessResponse discriminator mapping keys", () => {
    const writeSuccess = spec.components.schemas.WriteSuccessResponse;
    const mappingKeys = Object.keys(writeSuccess.discriminator.mapping);
    expect(new Set(mappingKeys)).toEqual(new Set(runtimeOps));
  });

  it("dispatch table matches WriteSuccessResponse oneOf refs", () => {
    const writeSuccess = spec.components.schemas.WriteSuccessResponse;
    const oneOfRefs = writeSuccess.oneOf.map((s) => s.$ref.split("/").pop()!);
    expect(oneOfRefs.length).toBe(runtimeOps.length);
    for (const ref of oneOfRefs) {
      const schema = spec.components.schemas[ref];
      expect(schema).toBeDefined();
    }
  });

  it("request operation const values match runtime dispatch table", () => {
    const requestSchemas = runtimeOps.map((op) => {
      const pascal = op
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
      const schemaName = pascal + "Request";
      const schema = spec.components.schemas[schemaName];
      expect(schema).toBeDefined();
      return schema.properties.operation.const;
    });
    expect(new Set(requestSchemas)).toEqual(new Set(runtimeOps));
  });

  it("success operation const values match runtime dispatch table", () => {
    const successSchemas = runtimeOps.map((op) => {
      const pascal = op
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
      const schemaName = pascal + "Success";
      const schema = spec.components.schemas[schemaName];
      expect(schema).toBeDefined();
      // The operation const is nested in the allOf composition
      const composition = schema.allOf.find((s) => s.properties?.operation?.const !== undefined);
      expect(composition).toBeDefined();
      return composition!.properties.operation.const;
    });
    expect(new Set(successSchemas)).toEqual(new Set(runtimeOps));
  });

  it("handler data.<field> reads match request schema properties", () => {
    for (const { op, handlerName } of runtimeCases) {
      const handlerFields = extractHandlerFields(sources, handlerName);
      // The handler reads data.operation too, which maps to the discriminator
      const allHandlerFields = new Set(["operation", ...handlerFields]);

      const pascal = op
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
      const schemaName = pascal + "Request";
      const schema = spec.components.schemas[schemaName];
      const schemaProps = new Set(Object.keys(schema.properties ?? {}));

      // Handler fields should be a subset of schema properties
      for (const field of allHandlerFields) {
        if (!schemaProps.has(field)) {
          throw new Error(
            `Handler "${handlerName}" (operation "${op}") reads data.${field} but it is not in the ${schemaName} schema properties: ${[...schemaProps].join(", ")}`,
          );
        }
      }
    }
  });

  it("successResult first argument matches dispatch case", () => {
    for (const { op, handlerName } of runtimeCases) {
      const successOp = extractSuccessOperation(sources, handlerName);
      if (successOp === null) {
        throw new Error(
          `Handler "${handlerName}" has no statically identifiable successResult call`,
        );
      }
      expect(successOp).toBe(op);
    }
  });

  it("info.version equals VERSION file", () => {
    expect(spec.info.version).toBe(version);
  });

  it("server URL is the local Zotero URL", () => {
    expect(spec.servers[0].url).toBe("http://127.0.0.1:23119");
  });

  it("paths agree with config.yml", () => {
    expect(spec.paths["/attach"]).toBeDefined();
    expect(spec.paths["/write"]).toBeDefined();
    expect(spec.paths["/version"]).toBeDefined();
    // config.yml has the endpoint paths
    expect(config.endpoints.attach).toBe("/attach");
    expect(config.endpoints.write).toBe("/write");
    expect(config.endpoints.version).toBe("/version");
  });

  it("success envelope requires details", () => {
    const successEnv = spec.components.schemas.SuccessEnvelope;
    expect(successEnv.required).toContain("details");
  });

  it("version response has all required nested fields", () => {
    const versionResp = spec.components.schemas.VersionResponse;
    expect(versionResp.required).toContain("endpoints");
    expect(versionResp.required).toContain("compatibility");
    expect(versionResp.required).toContain("capabilities");
    expect(versionResp.properties.endpoints.required).toContain("attach");
    expect(versionResp.properties.endpoints.required).toContain("write");
    expect(versionResp.properties.endpoints.required).toContain("version");
    expect(versionResp.properties.compatibility.required).toContain("strict_min_version");
    expect(versionResp.properties.compatibility.required).toContain("strict_max_version");
    expect(versionResp.properties.compatibility.required).toContain("tested_zotero_version");
  });

  it("attach success response has required top-level fields", () => {
    const attachSuccess = spec.components.schemas.AttachSuccessResponse;
    const topProps = attachSuccess.allOf[1].required ?? [];
    expect(topProps).toContain("attachment_key");
    expect(topProps).toContain("attachment_id");
    expect(topProps).toContain("message");
    expect(topProps).toContain("handler");
  });
});
