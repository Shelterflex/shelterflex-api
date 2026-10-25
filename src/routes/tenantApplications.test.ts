import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createTenantApplicationsRouter } from "./tenantApplications.js";
import { InMemoryTenantApplicationStore } from "../models/tenantApplicationStore.js";
import { initTenantApplicationStore } from "../models/tenantApplicationStore.js";
import { errorHandler } from "../middleware/errorHandler.js";

// Mock the auth middleware
vi.mock("../middleware/auth.js", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { id: "test-user-123" };
    next();
  },
}));

describe("Tenant Applications Routes", () => {
  let app: express.Application;
  let store: InMemoryTenantApplicationStore;

  beforeEach(async () => {
    store = new InMemoryTenantApplicationStore();
    initTenantApplicationStore(store);

    app = express();
    app.use(express.json());
    app.use("/api/tenant/applications", createTenantApplicationsRouter());
    app.use(errorHandler);

    await store.clear();
  });

  describe("POST /api/tenant/applications", () => {
    it("should create a new application with valid data", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000, // 20% of annual rent
        duration: 12,
        hasAgreedToTerms: true,
        propertyTitle: "Modern 3BR Apartment",
        propertyLocation: "Lekki Phase 1, Lagos",
      };

      const response = await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        userId: "test-user-123",
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        totalAmount: 1920000, // 2400000 - 480000
        monthlyPayment: 160000, // 1920000 / 12
        status: "pending",
        hasAgreedToTerms: true,
      });
      expect(response.body.data.applicationId).toBeDefined();
      expect(response.body.data.createdAt).toBeDefined();
    });

    it("should reject application with deposit less than 20%", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        deposit: 400000, // Less than 20%
        duration: 12,
        hasAgreedToTerms: true,
      };

      await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(400);
    });

    it("should reject application with deposit >= annual rent", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        deposit: 2400000,
        duration: 12,
        hasAgreedToTerms: true,
      };

      await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(400);
    });

    it("should reject application without terms agreement", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        hasAgreedToTerms: false,
      };

      await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(400);
    });

    it("should reject application with invalid duration", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 25, // Max is 24
        hasAgreedToTerms: true,
      };

      await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(400);
    });

    it("should reject application with missing required fields", async () => {
      const payload = {
        propertyId: 1,
        annualRent: 2400000,
        // Missing deposit, duration, hasAgreedToTerms
      };

      await request(app)
        .post("/api/tenant/applications")
        .send(payload)
        .expect(400);
    });
  });

  describe("GET /api/tenant/applications/:applicationId", () => {
    it("should retrieve an application by ID", async () => {
      const application = await store.create({
        userId: "test-user-123",
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        hasAgreedToTerms: true,
      });

      const response = await request(app)
        .get(`/api/tenant/applications/${application.applicationId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.applicationId).toBe(application.applicationId);
    });

    it("should return 404 for non-existent application", async () => {
      await request(app)
        .get("/api/tenant/applications/non-existent-id")
        .expect(404);
    });

    it("should deny access to other users applications", async () => {
      const application = await store.create({
        userId: "other-user-456",
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        hasAgreedToTerms: true,
      });

      await request(app)
        .get(`/api/tenant/applications/${application.applicationId}`)
        .expect(403);
    });
  });

  describe("GET /api/tenant/applications", () => {
    it("should list applications for authenticated user", async () => {
      await store.create({
        userId: "test-user-123",
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        hasAgreedToTerms: true,
      });

      await store.create({
        userId: "test-user-123",
        propertyId: 2,
        annualRent: 1800000,
        deposit: 360000,
        duration: 6,
        hasAgreedToTerms: true,
      });

      // Create application for different user
      await store.create({
        userId: "other-user-456",
        propertyId: 3,
        annualRent: 3000000,
        deposit: 600000,
        duration: 12,
        hasAgreedToTerms: true,
      });

      const response = await request(app)
        .get("/api/tenant/applications")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(
        response.body.data.every((app: any) => app.userId === "test-user-123"),
      ).toBe(true);
    });

    it("should filter applications by status", async () => {
      const app1 = await store.create({
        userId: "test-user-123",
        propertyId: 1,
        annualRent: 2400000,
        deposit: 480000,
        duration: 12,
        hasAgreedToTerms: true,
      });

      await store.updateStatus(app1.applicationId, "approved" as any);

      await store.create({
        userId: "test-user-123",
        propertyId: 2,
        annualRent: 1800000,
        deposit: 360000,
        duration: 6,
        hasAgreedToTerms: true,
      });

      const response = await request(app)
        .get("/api/tenant/applications?status=pending")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].status).toBe("pending");
    });

    it("should support pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({
          userId: "test-user-123",
          propertyId: i,
          annualRent: 2400000,
          deposit: 480000,
          duration: 12,
          hasAgreedToTerms: true,
        });
      }

      const response = await request(app)
        .get("/api/tenant/applications?limit=3")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(3);
      expect(response.body.nextCursor).toBeDefined();
    });
  });
});
