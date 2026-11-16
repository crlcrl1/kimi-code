import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch']);

function extractPropertySummary(schema: unknown): {
  properties: string[];
  required: string[];
} {
  if (typeof schema !== 'object' || schema === null) {
    return { properties: [], required: [] };
  }
  const s = schema as Record<string, unknown>;
  const props =
    typeof s['properties'] === 'object' && s['properties'] !== null
      ? Object.keys(s['properties'] as Record<string, unknown>).toSorted()
      : [];
  const req = Array.isArray(s['required'])
    ? [...(s['required'] as string[])].toSorted()
    : [];
  return { properties: props, required: req };
}

function summarizeSuccessData(op: Record<string, unknown>): unknown {
  const responses = op['responses'] as Record<string, unknown> | undefined;
  const res200 = responses?.['200'] as Record<string, unknown> | undefined;
  const content = res200?.['content'] as Record<string, unknown> | undefined;
  if (content === undefined) return null;
  if (content['application/json'] === undefined) {
    return { contentTypes: Object.keys(content).toSorted() };
  }
  const schema = (content['application/json'] as Record<string, unknown>)['schema'] as
    | Record<string, unknown>
    | undefined;
  if (schema === undefined) return null;
  const candidates = Array.isArray(schema['oneOf'])
    ? (schema['oneOf'] as Record<string, unknown>[])
    : [schema];
  const okVariant = candidates.find((v) => {
    const props = v['properties'] as Record<string, unknown> | undefined;
    const codeProp = props?.['code'] as Record<string, unknown> | undefined;
    const enums = codeProp?.['enum'] as unknown[] | undefined;
    return codeProp?.['const'] === 0 || (Array.isArray(enums) && enums.includes(0));
  });
  const dataSchema = (okVariant?.['properties'] as Record<string, unknown> | undefined)?.['data'];
  if (dataSchema === undefined) return null;
  const d = dataSchema as Record<string, unknown>;
  if (Array.isArray(d['oneOf']) || Array.isArray(d['anyOf'])) {
    const branches = ((d['oneOf'] ?? d['anyOf']) as unknown[]).map(extractPropertySummary);
    return { union: branches };
  }
  if (d['type'] === 'array') {
    return { arrayItems: extractPropertySummary(d['items']) };
  }
  return extractPropertySummary(d);
}

describe('KAP OpenAPI + AsyncAPI contract compatibility snapshot', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-kap-contract-snapshot-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close().catch(() => {});
      server = undefined;
    }
    if (home !== undefined) {
      rmSync(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('keeps public /openapi.json and /asyncapi.json shapes additive and hides internal routes', async () => {
    const base = `http://${server!.host}:${server!.port}`;
    const headers = authHeaders(server!);

    const openApiRes = await fetch(`${base}/openapi.json`, { headers } as never);
    expect(openApiRes.status).toBe(200);
    const openApi = (await openApiRes.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    expect(
      Object.keys(openApi.paths).filter(
        (p) => p.startsWith('/api/v1/debug') || p.startsWith('/api/v1/client-configs'),
      ),
    ).toEqual([]);

    const restOperations: Record<string, unknown> = {};
    for (const path of Object.keys(openApi.paths).toSorted()) {
      const item = openApi.paths[path]!;
      for (const method of Object.keys(item).toSorted()) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;
        const op = item[method] as Record<string, unknown>;
        const parameters = Array.isArray(op['parameters'])
          ? (op['parameters'] as Array<Record<string, unknown>>)
              .map((p) => ({
                in: p['in'],
                name: p['name'],
                required: p['required'] === true,
              }))
              .toSorted((a, b) => String(a.name).localeCompare(String(b.name)))
          : [];
        const bodyContent = (
          (op['requestBody'] as Record<string, unknown> | undefined)?.['content'] as
            | Record<string, unknown>
            | undefined
        )?.['application/json'] as Record<string, unknown> | undefined;
        const bodySchema = bodyContent?.['schema'];
        restOperations[`${method.toUpperCase()} ${path}`] = {
          parameters,
          body: bodySchema === undefined ? null : extractPropertySummary(bodySchema),
          responseData: summarizeSuccessData(op),
        };
      }
    }

    const asyncApiRes = await fetch(`${base}/asyncapi.json`, { headers } as never);
    expect(asyncApiRes.status).toBe(200);
    const asyncApi = (await asyncApiRes.json()) as {
      components?: { messages?: Record<string, { name?: string; payload?: unknown }> };
    };
    const wsMessages: Record<string, unknown> = {};
    const messages = asyncApi.components?.messages ?? {};
    for (const key of Object.keys(messages).toSorted()) {
      const msg = messages[key]!;
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (payload !== undefined && (Array.isArray(payload['oneOf']) || Array.isArray(payload['anyOf']))) {
        wsMessages[msg.name ?? key] = {
          union: ((payload['oneOf'] ?? payload['anyOf']) as unknown[]).map(extractPropertySummary),
        };
      } else {
        wsMessages[msg.name ?? key] = extractPropertySummary(payload);
      }
    }

    expect({ restOperations, wsMessages }).toMatchSnapshot();
  });
});
