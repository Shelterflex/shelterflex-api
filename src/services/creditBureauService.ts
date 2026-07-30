/**
 * Credit Bureau Service
 * Orchestrates credit report retrieval with caching
 */

import { getCreditBureauProvider } from "./creditBureau/CreditBureauFactory.js";
import { creditBureauReportStore } from "../models/creditBureauReportStore.js";
import { CreditReport } from "./creditBureau/CreditBureauProvider.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";

export class CreditBureauService {
  /**
   * Pull credit report, using cache if valid, otherwise fetch from bureau
   */
  async pullReport(
    tenantId: string,
    bvn: string,
    nin: string,
  ): Promise<CreditReport> {
    // Check for valid cached report
    const cached = await creditBureauReportStore.findLatestByTenantId(tenantId);
    if (cached && new Date(cached.expiresAt) > new Date()) {
      logger.info(`Using cached credit report for tenant ${tenantId}`);
      return cached.report;
    }

    // Fetch from bureau with timeout and retry
    const provider = getCreditBureauProvider();
    let report: CreditReport;

    try {
      report = await this.withTimeout(
        provider.pullReport(tenantId, bvn, nin),
        10000,
      );
    } catch (error) {
      logger.error(
        `Failed to pull credit report for tenant ${tenantId}:`,
        undefined,
        error,
      );
      throw new AppError(
        ErrorCode.EXTERNAL_SERVICE_ERROR,
        503,
        "Failed to retrieve credit report from bureau",
      );
    }

    // Cache the report
    await creditBureauReportStore.create({
      tenantId,
      bvn,
      nin,
      report,
    });

    return report;
  }

  /**
   * Get cached report without pulling from bureau
   */
  async getCachedReport(tenantId: string): Promise<CreditReport | null> {
    const cached = await creditBureauReportStore.findLatestByTenantId(tenantId);
    if (cached && new Date(cached.expiresAt) > new Date()) {
      return cached.report;
    }
    return null;
  }

  /**
   * Utility: Promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Request timeout")), timeoutMs),
      ),
    ]);
  }
}

export const creditBureauService = new CreditBureauService();
