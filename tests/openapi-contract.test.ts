import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

// Parse openapi.yaml with a minimal YAML parser (js-yaml is already
// available as a transitive dependency of redocly).
const yaml = require("js-yaml");

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BOOTSTRAP_PATH = path.join(REPO_ROOT, "src", "bootstrap.ts");
const OPENAPI_PATH = path.join(REPO_ROOT, "openapi.yaml");
const CONFIG_PATH = path.join(REPO_ROOT, "config.yml");
const VERSION_PATH = path.join(REPO_ROOT, "VERSION");

// ── Helpers ────────────────────────────────────────────────────

function parseBootstrap(): ts.SourceFile {
  const source = fs.readFileSync(BOOTSTRAP_PATH, "utf8");
  return ts.createSourceFile(
    "bootstrap.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
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

// Find the runWrite function and its switch statement
function findRunWriteSwitch(source: ts.SourceFile): ts.SwitchStatement | null {
  let result: ts.SwitchStatement | null = null;

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runWrite") {
      function findSwitch(n: ts.Node) {
        if (ts.isSwitchStatement(n)) {
          result = n;
          return;
        }
        ts.forEachChild(n, findSwitch);
        if (result) {
          return;
        }
      }
      findSwitch(node);
    }
    if (!result) {
      ts.forEachChild(node, visit);
    }
  }
  visit(source);
  return result;
}

// Extract switch case strings and the handler call for each
function extractSwitchCases(switchStmt: ts.SwitchStatement): { op: string; handlerName: string }[] {
  const cases: { op: string; handlerName: string }[] = [];

  for (const clause of switchStmt.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      continue;
    }

    const caseExpr = clause.expression;
    if (!ts.isStringLiteral(caseExpr)) {
      throw new Error(`Non-literal switch case at position ${cases.length}`);
    }
    const op = caseExpr.text;

    // Check for fall-through: must have exactly one return statement
    const returnStmts = clause.statements.filter(ts.isReturnStatement);
    if (returnStmts.length !== 1) {
      throw new Error(
        `Case "${op}" must have exactly one return statement, got ${returnStmts.length}`,
      );
    }

    const ret = returnStmts[0];
    if (!ret.expression || !ts.isCallExpression(ret.expression)) {
      throw new Error(`Case "${op}" return must be a function call`);
    }

    // Extract handler name: return handleX(data) or return handleX()
    const callExpr = ret.expression;
    let handlerName: string;
    if (ts.isIdentifier(callExpr.expression)) {
      handlerName = callExpr.expression.text;
    } else {
      throw new Error(`Case "${op}" handler call expression is not a simple identifier`);
    }

    cases.push({ op, handlerName });
  }

  // Check for duplicates
  const ops = cases.map((c) => c.op);
  const duplicates = ops.filter((op, i) => ops.indexOf(op) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate switch cases: ${duplicates.join(", ")}`);
  }

  return cases;
}

// Find the handler function and extract data.<field> reads
function extractHandlerFields(source: ts.SourceFile, handlerName: string): string[] {
  const fields = new Set<string>();

  function visit(node: ts.Node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) &&
      ((ts.isFunctionDeclaration(node) && node.name?.text === handlerName) ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (d) => ts.isIdentifier(d.name) && d.name.text === handlerName,
          )))
    ) {
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
      ts.forEachChild(node, walkForData);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...fields].sort();
}

// Find the first string argument to successResult() in a handler
function extractSuccessOperation(source: ts.SourceFile, handlerName: string): string | null {
  let result: string | null = null;

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === handlerName) {
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
      findSuccessCall(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────

describe("OpenAPI contract conformance", () => {
  const source = parseBootstrap();
  const spec = parseOpenAPI();
  const config = parseConfig();
  const version = fs.readFileSync(VERSION_PATH, "utf8").trim();

  const switchStmt = findRunWriteSwitch(source);
  if (!switchStmt) {
    throw new Error("Could not find runWrite switch statement in bootstrap.ts");
  }

  const runtimeCases = extractSwitchCases(switchStmt);
  const runtimeOps = runtimeCases.map((c) => c.op);

  it("runtime has exactly 33 operations", () => {
    expect(runtimeOps.length).toBe(33);
  });

  it("switch cases match WriteRequest discriminator mapping keys", () => {
    const writeReq = spec.components.schemas.WriteRequest;
    const mappingKeys = Object.keys(writeReq.discriminator.mapping);
    expect(new Set(mappingKeys)).toEqual(new Set(runtimeOps));
  });

  it("switch cases match WriteRequest oneOf refs", () => {
    const writeReq = spec.components.schemas.WriteRequest;
    const oneOfRefs = writeReq.oneOf.map((s) => s.$ref.split("/").pop()!);
    expect(oneOfRefs.length).toBe(33);
    // Each ref should point to a schema whose operation const matches a runtime op
    for (const ref of oneOfRefs) {
      const schema = spec.components.schemas[ref];
      expect(schema).toBeDefined();
      const constVal = schema.properties.operation.const;
      expect(runtimeOps).toContain(constVal);
    }
  });

  it("switch cases match WriteSuccessResponse discriminator mapping keys", () => {
    const writeSuccess = spec.components.schemas.WriteSuccessResponse;
    const mappingKeys = Object.keys(writeSuccess.discriminator.mapping);
    expect(new Set(mappingKeys)).toEqual(new Set(runtimeOps));
  });

  it("switch cases match WriteSuccessResponse oneOf refs", () => {
    const writeSuccess = spec.components.schemas.WriteSuccessResponse;
    const oneOfRefs = writeSuccess.oneOf.map((s) => s.$ref.split("/").pop()!);
    expect(oneOfRefs.length).toBe(33);
    for (const ref of oneOfRefs) {
      const schema = spec.components.schemas[ref];
      expect(schema).toBeDefined();
    }
  });

  it("request operation const values match runtime switch cases", () => {
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

  it("success operation const values match runtime switch cases", () => {
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
      const handlerFields = extractHandlerFields(source, handlerName);
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
      const successOp = extractSuccessOperation(source, handlerName);
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
