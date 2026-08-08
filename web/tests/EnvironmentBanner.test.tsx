// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EnvironmentBanner } from "../src/components/EnvironmentBanner";
import type { AppStatus } from "../src/types";

const baseStatus: AppStatus = {
  storageMode: "local",
  availableTargets: ["local"],
  funnel: {
    collected: { items: 0, rows: 0, breakdown: { total: 0, reach: { kind: "unknown" } } },
    translated: { items: 0, rows: 0 },
    converted: { items: 0, rows: 0 },
    rendered: { items: 0, rows: 0 },
    published: { items: 0, rows: 0 },
  },
  sync: { synced: 0, needsRepublish: 0, unpublished: 0 },
  integrations: [],
  sheetLinks: {},
  dbEnv: "production",
  sendsEnabled: true,
};

afterEach(cleanup);

describe("EnvironmentBanner", () => {
  it("shows a banner when the dashboard is not on the production database", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, dbEnv: "development" }} />);
    expect(screen.getByText(/개발 데이터베이스/)).toBeTruthy();
  });

  it("shows no banner on production", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, dbEnv: "production" }} />);
    expect(screen.queryByText(/개발 데이터베이스/)).toBeNull();
  });

  it("shows no banner when dbEnv is absent (an older cached response) rather than guessing", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, dbEnv: undefined }} />);
    expect(screen.queryByText(/개발 데이터베이스/)).toBeNull();
  });

  it("shows a banner when sends are closed", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, sendsEnabled: false }} />);
    expect(screen.getByText(/발송이 아직 열려 있지 않습니다/)).toBeTruthy();
  });

  it("shows no sends banner once sends are open", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, sendsEnabled: true }} />);
    expect(screen.queryByText(/발송이 아직 열려 있지 않습니다/)).toBeNull();
  });

  it("can show both banners at once", () => {
    render(<EnvironmentBanner status={{ ...baseStatus, dbEnv: "development", sendsEnabled: false }} />);
    expect(screen.getByText(/개발 데이터베이스/)).toBeTruthy();
    expect(screen.getByText(/발송이 아직 열려 있지 않습니다/)).toBeTruthy();
  });

  it("renders nothing before status has loaded", () => {
    const { container } = render(<EnvironmentBanner status={null} />);
    expect(container.firstChild).toBeNull();
  });
});
