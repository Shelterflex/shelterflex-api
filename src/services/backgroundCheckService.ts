/**
 * Background Check Service
 * Orchestrates employment, income, and bank statement verification for tenant screening
 */

import { getBackgroundCheckProvider } from "./backgroundCheck/BackgroundCheckFactory.js";
import { backgroundCheckResultStore } from "../models/backgroundCheckResultStore.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";

export interface BackgroundCheckInput {
  tenantId: string;
  applicationId?: string;
  employerName?: string;
  employeeId?: string;
  bankAccountRef?: string;
  statementFile?: string;
  skipEmployment?: boolean;
  skipIncome?: boolean;
  skipBankStatement?: boolean;
  /**
   * If provided and it matches an existing result owned by the same tenant,
   * the run updates that result in place instead of creating a duplicate.
   */
  existingCheckId?: string;
}

export interface BackgroundCheckOutput {
  id: string;
  tenantId: string;
  applicationId?: string;
  employmentVerification?: {
    verified: boolean;
    employerName: string;
    jobTitle: string;
    startDate: string;
    employmentType: string;
    monthlyIncome?: number;
  };
  incomeVerification?: {
    averageMonthlyIncome: number;
    incomeStability: string;
    lastSalaryDate: string;
    transactionCount3m: number;
  };
  bankStatementVerification?: {
    averageBalance: number;
    monthlyInflow: number;
    monthlyOutflow: number;
    overdraftCount: number;
  };
  overallStatus: string;
  provider: string;
  createdAt: string;
  /** Whether the application can proceed based on the verification results. */
  eligible: boolean;
  /** Recorded reasons for an adverse (gating) decision, empty when eligible. */
  adverseReasons: string[];
}

export class BackgroundCheckService {
  private provider = getBackgroundCheckProvider();

  /**
   * Run full background check for a tenant
   */
  async runFullCheck(input: BackgroundCheckInput): Promise<BackgroundCheckOutput> {
    logger.info(`Starting full background check for tenant ${input.tenantId}`);

    // Re-running against an existing check id updates that result in place
    // rather than creating a duplicate record.
    let result = null;
    if (input.existingCheckId) {
      const existing = await backgroundCheckResultStore.findById(
        input.existingCheckId,
      );
      if (existing && existing.tenantId === input.tenantId) {
        result = await backgroundCheckResultStore.update(existing.id, {
          overallStatus: "pending",
        });
      }
    }

    if (!result) {
      // Create initial record with pending status
      result = await backgroundCheckResultStore.create({
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        overallStatus: "pending",
        provider: "mock",
      });
    }

    let employmentData;
    let incomeData;
    let bankData;

    try {
      // Employment verification
      if (!input.skipEmployment && input.employerName) {
        try {
          employmentData = await this.withTimeout(
            this.provider.verifyEmployment(
              input.tenantId,
              input.employerName,
              input.employeeId,
            ),
            15000,
          );
          logger.info(
            `Employment verification completed for tenant ${input.tenantId}`,
          );
        } catch (error) {
          logger.error(
            `Employment verification failed for tenant ${input.tenantId}:`,
            undefined,
            error,
          );
          throw new AppError(
            ErrorCode.EXTERNAL_SERVICE_ERROR,
            503,
            "Employment verification service unavailable",
          );
        }
      }

      // Income verification
      if (!input.skipIncome && input.bankAccountRef) {
        try {
          incomeData = await this.withTimeout(
            this.provider.verifyIncome(input.tenantId, input.bankAccountRef),
            15000,
          );
          logger.info(
            `Income verification completed for tenant ${input.tenantId}`,
          );
        } catch (error) {
          logger.error(
            `Income verification failed for tenant ${input.tenantId}:`,
            undefined,
            error,
          );
          throw new AppError(
            ErrorCode.EXTERNAL_SERVICE_ERROR,
            503,
            "Income verification service unavailable",
          );
        }
      }

      // Bank statement verification
      if (!input.skipBankStatement && input.statementFile) {
        try {
          bankData = await this.withTimeout(
            this.provider.verifyBankStatement(input.tenantId, input.statementFile),
            20000,
          );
          logger.info(
            `Bank statement verification completed for tenant ${input.tenantId}`,
          );
        } catch (error) {
          logger.error(
            `Bank statement verification failed for tenant ${input.tenantId}:`,
            undefined,
            error,
          );
          throw new AppError(
            ErrorCode.EXTERNAL_SERVICE_ERROR,
            503,
            "Bank statement verification service unavailable",
          );
        }
      }

      const adverseReasons = this.computeAdverseReasons(
        employmentData,
        incomeData,
        bankData,
      );

      // Update result with completed status
      const updated = await backgroundCheckResultStore.update(result.id, {
        employmentVerified: employmentData?.verified,
        employerName: employmentData?.employerName,
        jobTitle: employmentData?.jobTitle,
        employmentStartDate: employmentData?.startDate,
        employmentType: employmentData?.employmentType,
        employmentMonthlyIncome: employmentData?.monthlyIncome,
        employmentVerificationDate: employmentData?.verificationDate,
        incomeAverageMonthly: incomeData?.averageMonthlyIncome,
        incomeStability: incomeData?.incomeStability,
        incomeLastSalaryDate: incomeData?.lastSalaryDate,
        incomeTransactionCount3m: incomeData?.transactionCount3m,
        incomeVerificationDate: incomeData?.verificationDate,
        bankAverageBalance: bankData?.averageBalance,
        bankMonthlyInflow: bankData?.monthlyInflow,
        bankMonthlyOutflow: bankData?.monthlyOutflow,
        bankOverdraftCount: bankData?.overdraftCount,
        bankStatementStartDate: bankData?.statementPeriod?.startDate,
        bankStatementEndDate: bankData?.statementPeriod?.endDate,
        bankVerificationDate: bankData?.verificationDate,
        overallStatus: "completed",
        verificationMetadata: { adverseReasons },
      });

      logger.info(
        `Full background check completed for tenant ${input.tenantId}`,
      );

      return this.mapToOutput(updated);
    } catch (error) {
      // Mark as failed on error
      await backgroundCheckResultStore.update(result.id, {
        overallStatus: "failed",
      });
      throw error;
    }
  }

  /**
   * Get latest background check result for a tenant
   */
  async getLatestCheck(tenantId: string): Promise<BackgroundCheckOutput | null> {
    const result = await backgroundCheckResultStore.findLatestByTenantId(
      tenantId,
    );
    return result ? this.mapToOutput(result) : null;
  }

  /**
   * Get background check result by ID
   */
  async getCheckById(id: string): Promise<BackgroundCheckOutput | null> {
    const result = await backgroundCheckResultStore.findById(id);
    return result ? this.mapToOutput(result) : null;
  }

  /**
   * Get background checks for an application
   */
  async getChecksByApplicationId(
    applicationId: string,
  ): Promise<BackgroundCheckOutput[]> {
    const results =
      await backgroundCheckResultStore.findByApplicationId(applicationId);
    return results.map((r) => this.mapToOutput(r));
  }

  /**
   * Derive adverse-action reasons from verification results. An empty list
   * means the application is eligible to proceed.
   */
  private computeAdverseReasons(
    employmentData?: { verified: boolean },
    incomeData?: { incomeStability: string },
    bankData?: { overdraftCount: number },
  ): string[] {
    const reasons: string[] = [];

    if (employmentData && !employmentData.verified) {
      reasons.push("Employment could not be verified");
    }
    if (incomeData && incomeData.incomeStability === "unstable") {
      reasons.push("Income stability does not meet requirements");
    }
    if (bankData && bankData.overdraftCount > 2) {
      reasons.push("Excessive overdraft history");
    }

    return reasons;
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

  /**
   * Map database result to output format
   */
  private mapToOutput(result: any): BackgroundCheckOutput {
    const adverseReasons: string[] = result.verificationMetadata?.adverseReasons || [];
    const output: BackgroundCheckOutput = {
      id: result.id,
      tenantId: result.tenantId,
      applicationId: result.applicationId,
      overallStatus: result.overallStatus,
      provider: result.provider,
      createdAt: result.createdAt,
      eligible: result.overallStatus === "completed" && adverseReasons.length === 0,
      adverseReasons,
    };

    if (result.employmentVerified !== undefined) {
      output.employmentVerification = {
        verified: result.employmentVerified,
        employerName: result.employerName || "",
        jobTitle: result.jobTitle || "",
        startDate: result.employmentStartDate || "",
        employmentType: result.employmentType || "",
        monthlyIncome: result.employmentMonthlyIncome,
      };
    }

    if (result.incomeAverageMonthly !== undefined) {
      output.incomeVerification = {
        averageMonthlyIncome: result.incomeAverageMonthly,
        incomeStability: result.incomeStability || "",
        lastSalaryDate: result.incomeLastSalaryDate || "",
        transactionCount3m: result.incomeTransactionCount3m || 0,
      };
    }

    if (result.bankAverageBalance !== undefined) {
      output.bankStatementVerification = {
        averageBalance: result.bankAverageBalance,
        monthlyInflow: result.bankMonthlyInflow || 0,
        monthlyOutflow: result.bankMonthlyOutflow || 0,
        overdraftCount: result.bankOverdraftCount || 0,
      };
    }

    return output;
  }
}

export const backgroundCheckService = new BackgroundCheckService();
