import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, UpstreamError } from "../errors";
import { createRemoteClient } from "./client";
import { MOCK_PRODUCTS } from "./mock-data";

const client = createRemoteClient("http://remote.test/v1");

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (res: Response | Error) =>
  vi.stubGlobal("fetch", vi.fn(async () => (res instanceof Error ? Promise.reject(res) : res)));

describe("remote client", () => {
  it("parses a valid list payload", async () => {
    stubFetch(Response.json({ items: MOCK_PRODUCTS }));
    expect(await client.listProducts()).toHaveLength(MOCK_PRODUCTS.length);
  });

  it("maps 404 to NotFoundError", async () => {
    stubFetch(new Response(null, { status: 404 }));
    await expect(client.getProduct("x")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps 5xx, network failures and bad payloads to UpstreamError", async () => {
    stubFetch(new Response(null, { status: 500 }));
    await expect(client.listProducts()).rejects.toBeInstanceOf(UpstreamError);
    stubFetch(new Error("boom"));
    await expect(client.listProducts()).rejects.toBeInstanceOf(UpstreamError);
    stubFetch(Response.json({ items: [{ nope: true }] }));
    await expect(client.listProducts()).rejects.toBeInstanceOf(UpstreamError);
  });
});
