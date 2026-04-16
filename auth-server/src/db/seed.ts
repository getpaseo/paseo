import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { plan, planFeature } from "./schema";
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const db = drizzle(pool);

const PLANS = [
  {
    id: "plan_free",
    name: "Free",
    slug: "free",
    stripeMonthlyPriceId: null,
    stripeYearlyPriceId: null,
    monthlyPriceCents: 0,
    yearlyPriceCents: 0,
    features: {
      max_members: { value: "3", description: "Maximum members per organization" },
      max_organizations: { value: "1", description: "Maximum organizations per user" },
      max_projects: { value: "5", description: "Maximum projects per organization" },
      max_sessions: { value: "3", description: "Maximum concurrent sessions" },
      priority_support: { value: "false", description: "Priority support access" },
      custom_branding: { value: "false", description: "Custom branding for organization" },
      api_access: { value: "false", description: "API access for integrations" },
      audit_log: { value: "false", description: "Audit log for compliance" },
    },
  },
  {
    id: "plan_pro",
    name: "Pro",
    slug: "pro",
    stripeMonthlyPriceId: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || null,
    stripeYearlyPriceId: process.env.STRIPE_PRO_YEARLY_PRICE_ID || null,
    monthlyPriceCents: 1900, // $19/mo
    yearlyPriceCents: 19000, // $190/yr ($15.83/mo — 2 meses grátis)
    features: {
      max_members: { value: "20", description: "Maximum members per organization" },
      max_organizations: { value: "5", description: "Maximum organizations per user" },
      max_projects: { value: "unlimited", description: "Maximum projects per organization" },
      max_sessions: { value: "10", description: "Maximum concurrent sessions" },
      priority_support: { value: "true", description: "Priority support access" },
      custom_branding: { value: "false", description: "Custom branding for organization" },
      api_access: { value: "true", description: "API access for integrations" },
      audit_log: { value: "false", description: "Audit log for compliance" },
    },
  },
  {
    id: "plan_enterprise",
    name: "Enterprise",
    slug: "enterprise",
    stripeMonthlyPriceId: process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID || null,
    stripeYearlyPriceId: process.env.STRIPE_ENTERPRISE_YEARLY_PRICE_ID || null,
    monthlyPriceCents: 4900, // $49/mo
    yearlyPriceCents: 49000, // $490/yr ($40.83/mo — 2 meses grátis)
    features: {
      max_members: { value: "unlimited", description: "Maximum members per organization" },
      max_organizations: { value: "unlimited", description: "Maximum organizations per user" },
      max_projects: { value: "unlimited", description: "Maximum projects per organization" },
      max_sessions: { value: "unlimited", description: "Maximum concurrent sessions" },
      priority_support: { value: "true", description: "Priority support access" },
      custom_branding: { value: "true", description: "Custom branding for organization" },
      api_access: { value: "true", description: "API access for integrations" },
      audit_log: { value: "true", description: "Audit log for compliance" },
    },
  },
];

async function seed() {
  console.log("Seeding plans...");

  for (const p of PLANS) {
    await db
      .insert(plan)
      .values({
        id: p.id,
        name: p.name,
        slug: p.slug,
        stripeMonthlyPriceId: p.stripeMonthlyPriceId,
        stripeYearlyPriceId: p.stripeYearlyPriceId,
        monthlyPriceCents: p.monthlyPriceCents,
        yearlyPriceCents: p.yearlyPriceCents,
      })
      .onConflictDoNothing();

    for (const [key, feat] of Object.entries(p.features)) {
      await db
        .insert(planFeature)
        .values({
          id: randomUUID(),
          planId: p.id,
          featureKey: key,
          value: feat.value,
          description: feat.description,
        })
        .onConflictDoNothing();
    }

    console.log(`  Seeded plan: ${p.name}`);
  }

  console.log("Done!");
  await pool.end();
}

seed().catch(console.error);
