import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createTenantSavedPropertiesRouter } from "./tenantSavedProperties.js";
import {
  InMemorySavedPropertyStore,
  initSavedPropertyStore,
} from "../models/savedPropertyStore.js";
import { errorHandler } from "../middleware/errorHandler.js";

vi.mock("../middleware/auth.js", () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: string } }).user = {
      id: "tenant-user-1",
    };
    next();
  },
}));

describe("Tenant Saved Properties Routes", () => {
  let app: express.Application;
  let store: InMemorySavedPropertyStore;

  beforeEach(async () => {
    store = new InMemorySavedPropertyStore();
    initSavedPropertyStore(store);

    app = express();
    app.use(express.json());
    app.use("/api/tenant/saved-properties", createTenantSavedPropertiesRouter());
    app.use(errorHandler);

    await store.clear();
  });

  it("returns empty list when nothing is saved", async () => {
    const response = await request(app)
      .get("/api/tenant/saved-properties")
      .expect(200);

    expect(response.body).toEqual({ success: true, data: [] });
  });

  it("saves and lists a property", async () => {
    await request(app)
      .post("/api/tenant/saved-properties/listing-abc")
      .expect(201);

    const response = await request(app)
      .get("/api/tenant/saved-properties")
      .expect(200);

    expect(response.body.data).toEqual(["listing-abc"]);
  });

  it("removes a saved property", async () => {
    await request(app).post("/api/tenant/saved-properties/listing-abc").expect(201);

    await request(app)
      .delete("/api/tenant/saved-properties/listing-abc")
      .expect(200);

    const response = await request(app)
      .get("/api/tenant/saved-properties")
      .expect(200);

    expect(response.body.data).toEqual([]);
  });
});
