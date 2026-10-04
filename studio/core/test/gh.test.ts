import { describe, expect, it } from "vitest"
import { blockedReason } from "../src/gh.js"

describe("a merge GitHub refuses", () => {
  it("names the failing required checks, not gh's raw output (ohara#135)", () => {
    const view = JSON.stringify({
      statusCheckRollup: [
        { context: "convex tests", state: "SUCCESS" },
        { context: "Vercel – ohara", state: "FAILURE", description: "Deployment was blocked" },
        { name: "platform lint", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
      reviewDecision: "",
    })
    const why = blockedReason("asaficontact/ohara", 135, view)
    expect(why).toContain("Checks failed: Vercel – ohara (Deployment was blocked)")
    expect(why).not.toContain("convex tests")
    expect(why).not.toMatch(/--admin|--auto/)
  })

  it("says when checks are still running, or a review is required", () => {
    expect(blockedReason("o/r", 1, JSON.stringify({ statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }] }))).toContain("Checks still running: build")
    expect(blockedReason("o/r", 1, JSON.stringify({ statusCheckRollup: [], reviewDecision: "REVIEW_REQUIRED" }))).toContain("approving review")
    expect(blockedReason("o/r", 1, "")).toContain("Open the pull request")
  })
})
