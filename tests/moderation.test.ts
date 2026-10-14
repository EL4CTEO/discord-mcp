import { describe, expect, it } from "vitest";
import { PermissionFlagsBits } from "discord-api-types/v10";
import { manageMemberRoles } from "../src/tools/members.js";
import { manageRole, reorderRoles } from "../src/tools/roles.js";
import { moderateMember } from "../src/tools/moderation.js";
import { config, fakeRest, registryWith } from "./helpers.js";

const GUILD = "100000000000000000";
const USER = "200000000000000000";
const BAN_TARGET = "400000000000000000";

const roles = [
  { id: "r-admin", name: "Admin", color: 0, position: 5, permissions: PermissionFlagsBits.Administrator.toString() },
  { id: "r-helper", name: "Helper", color: 0, position: 2, permissions: "0" },
  { id: "r-other", name: "Other", color: 0, position: 1, permissions: "0" },
];

const resolver = {
  guildId: async () => GUILD,
  roles: async () => roles,
  roleId: async (input: string) => roles.find((r) => r.name === input)?.id ?? input,
  member: async () => ({ id: USER, member: { user: { id: USER }, roles: [] } }),
  memberId: async () => USER,
  roleNames: async () => new Map<string, string>(),
  upsertRole: () => undefined,
  removeRole: () => undefined,
  setRoles: () => undefined,
};

/** Every call that changes state, i.e. anything other than a GET. */
/** Answers the fresh role read the escalation gate makes. */
const roleRoutes = (): Record<string, unknown> => ({ [`/guilds/${GUILD}/roles`]: roles });

const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== "GET");

describe("privilege-escalation guard on discord_manage_member_roles", () => {
  it("refuses to grant a role with Administrator when destructive actions are off", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([manageMemberRoles], { rest, resolver });

    await expect(
      registry.run("discord_manage_member_roles", { member: "someone", add: ["Admin"] }),
    ).rejects.toMatchObject({ code: "ELEVATED_PERMISSION" });
    expect(writes(calls)).toEqual([]);
  });

  it("grants the same role once destructive actions are enabled", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([manageMemberRoles], {
      rest,
      resolver,
      config: config({ allowDestructive: true }),
    });

    await registry.run("discord_manage_member_roles", { member: "someone", add: ["Admin"] });
    expect(calls.some((c) => c.method === "PUT" && c.route.includes("/roles/r-admin"))).toBe(true);
  });

  it("never gates removing an elevated role", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([manageMemberRoles], { rest, resolver });

    await registry.run("discord_manage_member_roles", { member: "someone", remove: ["Admin"] });
    expect(calls.some((c) => c.method === "DELETE" && c.route.includes("/roles/r-admin"))).toBe(true);
  });
});

describe("privilege-escalation guard on discord_manage_role", () => {
  it("refuses a new role carrying Ban Members when destructive actions are off", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([manageRole], { rest, resolver });

    await expect(
      registry.run("discord_manage_role", { action: "create", name: "Mods", permissions: ["BanMembers"] }),
    ).rejects.toMatchObject({ code: "ELEVATED_PERMISSION" });
    expect(writes(calls)).toEqual([]);
  });

  it("creates a role with only ordinary permissions", async () => {
    const created = { id: "r-new", name: "Talkers", color: 0, position: 1, permissions: "2048" };
    const { rest, calls } = fakeRest({ [`/guilds/${GUILD}/roles`]: created });
    const registry = registryWith([manageRole], { rest, resolver });

    const outcome = await registry.run("discord_manage_role", {
      action: "create",
      name: "Talkers",
      permissions: ["SendMessages"],
    });
    expect(outcome.summary).toContain("Created role");
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

describe("role colours on discord_manage_role", () => {
  it("sends colors.primary_color and colors.secondary_color instead of the deprecated color", async () => {
    const created = { id: "r-new", name: "Gradient", color: 0, position: 1, permissions: "0" };
    const { rest, calls } = fakeRest({ [`/guilds/${GUILD}/roles`]: created });
    const registry = registryWith([manageRole], { rest, resolver });

    await registry.run("discord_manage_role", {
      action: "create",
      name: "Gradient",
      color: "#5865F2",
      secondary_color: "#FF0000",
    });
    const body = calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    expect(body.color).toBeUndefined();
    expect(body.colors).toEqual({ primary_color: 0x5865f2, secondary_color: 0xff0000 });
  });

  it("refuses a secondary colour without a primary one", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([manageRole], { rest, resolver });

    await expect(
      registry.run("discord_manage_role", { action: "edit", role: "Helper", secondary_color: "#FF0000" }),
    ).rejects.toMatchObject({ code: "MISSING_ARG" });
    expect(writes(calls)).toEqual([]);
  });
});

describe("discord_reorder_roles room check", () => {
  it("refuses when the roles left unlisted push past the slots below the bot, before any PATCH", async () => {
    // The bot sits at position 4, so positions 1-3 are free beneath it. Ordering
    // r0 leaves r1-r3 unlisted, so four roles need three slots.
    const bot = "999999999999999999";
    const botRole = { id: "rbot", name: "Bot", color: 0, position: 4, permissions: "0" };
    const allRoles = [
      botRole,
      { id: "r0", name: "R0", color: 0, position: 3, permissions: "0" },
      { id: "r1", name: "R1", color: 0, position: 2, permissions: "0" },
      { id: "r2", name: "R2", color: 0, position: 1, permissions: "0" },
      { id: "r3", name: "R3", color: 0, position: 1, permissions: "0" },
      { id: GUILD, name: "@everyone", color: 0, position: 0, permissions: "0" },
    ];
    const { rest, calls } = fakeRest({
      [`/guilds/${GUILD}/members/${bot}`]: { user: { id: bot }, roles: ["rbot"] },
    });
    const registry = registryWith([reorderRoles], {
      rest,
      resolver: {
        ...resolver,
        roles: async () => allRoles,
        roleId: async (input: string) => input,
        selfId: async () => bot,
      },
    });

    await expect(
      registry.run("discord_reorder_roles", { order: ["r0", "r1", "r2"] }),
    ).rejects.toMatchObject({ code: "NO_ROOM" });
    expect(writes(calls)).toEqual([]);
  });
});

describe("discord_moderate_member destructive gate", () => {
  it("still unbans with destructive actions off", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([moderateMember], { rest, resolver });

    await registry.run("discord_moderate_member", { action: "unban", member: BAN_TARGET });
    expect(calls.some((c) => c.method === "DELETE" && c.route.includes(`/bans/${BAN_TARGET}`))).toBe(true);
  });

  it("refuses a ban with destructive actions off, before any REST call", async () => {
    const { rest, calls } = fakeRest(roleRoutes());
    const registry = registryWith([moderateMember], { rest, resolver });

    await expect(
      registry.run("discord_moderate_member", { action: "ban", member: BAN_TARGET, reason: "spam" }),
    ).rejects.toMatchObject({ code: "DESTRUCTIVE_DISABLED" });
    expect(calls).toEqual([]);
  });
});

describe("discord_manage_member_roles all-failed reporting", () => {
  it("throws ROLE_CHANGE_FAILED when every change in a multi-role call fails", async () => {
    // Every write to the member fails, so both the single PATCH and each per-role call are refused.
    const { rest } = fakeRest({ ...roleRoutes(), [`/members/${USER}`]: new Error("Missing Permissions") });
    const registry = registryWith([manageMemberRoles], { rest, resolver });

    const error = await registry
      .run("discord_manage_member_roles", { member: "someone", add: ["Helper"], remove: ["Other"] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ROLE_CHANGE_FAILED" });
    expect((error as { hint?: string }).hint).toContain("+Helper: ");
    expect((error as { hint?: string }).hint).toContain("-Other: ");
  });

  it("rethrows the original error for a single failed change", async () => {
    const { rest } = fakeRest({ ...roleRoutes(), [`/members/${USER}`]: new Error("Missing Permissions") });
    const registry = registryWith([manageMemberRoles], { rest, resolver });

    await expect(
      registry.run("discord_manage_member_roles", { member: "someone", add: ["Helper"] }),
    ).rejects.toThrow("Missing Permissions");
  });
});
