import { useState } from "react";

const COLORS = {
  burntOrange: "#CC4E0E",
  boneWhite: "#F5F2EB",
  charcoal: "#1D1D1D",
  steelBlue: "#3A5A8F",
  graphite: "#585858",
  white: "#FFFFFF",
  lightGray: "#E8E5DE",
  redAlert: "#B91C1C",
  greenGood: "#15803D",
  yellowWarn: "#A16207",
};

// --- DATA: foxhvacpro.com sample (replace per prospect) ---
const REPORT_DATA = {
  prospect: {
    company: "Fox HVAC Pro",
    domain: "foxhvacpro.com",
    market: "Boise, Idaho",
    industry: "HVAC",
    reportDate: "February 27, 2026",
  },
  marketPosition: {
    overallVisibility: "Very Low",
    visibilityScore: 8,
    totalKeywordsTracked: 1047,
    keywordsRanking: 156,
    top3: 12,
    top10: 38,
    top20: 67,
    competitorsAnalyzed: 3,
  },
  revenueExposure: {
    totalOpportunity: "$1,800,000+",
    currentCapture: "< 3%",
    topGapRevenue: "$682,500",
    topGapKeyword: "fox service company",
    gapExplanation:
      "Competitors are capturing an estimated $1.8M+ in annual revenue from search terms where Fox HVAC Pro is either invisible or holds less than 4% market share. The single largest exposure is a brand-confusion query worth up to $682K annually that a competitor currently owns.",
  },
  competitors: [
    {
      name: "a1heating.com",
      strength: "Dominant on broad HVAC category terms",
      keyTerms: "boise hvac, hvac boise, heating and cooling",
    },
    {
      name: "westernhvac.com",
      strength: "Owns repair + services queries",
      keyTerms: "repair boise, ac repair, hvac services boise",
    },
    {
      name: "rightnowheatcool.com",
      strength: "Strong on branded + geographic terms",
      keyTerms: "repair boise idaho, boise heating and",
    },
  ],
  authorityGaps: [
    {
      topic: "Brand-Confusion Queries",
      status: "Absent",
      competitor: "foxservice.com",
      volume: "1,300/mo",
      revenue: "$682,500",
      risk: "critical",
    },
    {
      topic: "AC / HVAC Repair — Boise",
      status: "Absent",
      competitor: "westernhvac.com",
      volume: "960/mo (combined)",
      revenue: "$524,000+",
      risk: "critical",
    },
    {
      topic: "Boise HVAC (Category Anchor)",
      status: "Absent",
      competitor: "a1heating.com",
      volume: "720/mo",
      revenue: "Untracked",
      risk: "high",
    },
    {
      topic: "Heating & Cooling (Broad)",
      status: "Absent",
      competitor: "a1heating.com",
      volume: "1,170/mo (combined)",
      revenue: "Untracked",
      risk: "high",
    },
    {
      topic: "HVAC Nampa / Treasure Valley",
      status: "Absent",
      competitor: "premier-hvac.com",
      volume: "340/mo (combined)",
      revenue: "Untracked",
      risk: "medium",
    },
  ],
  structuralRisk: {
    title: "Brand Confusion Is Costing You the Most",
    description:
      'foxservice.com currently owns 73% of search share on "fox service company" — a 1,300-volume query with a revenue ceiling of $682,500. Searchers looking for Fox HVAC Pro are finding a different company instead. This single gap represents the largest revenue leak in your search presence, and it will persist until a dedicated brand-clarification page is built.',
  },
  technicalGrade: {
    grade: "C+",
    summary:
      "The site loads adequately but has structural issues including missing schema markup, incomplete internal linking, and no XML sitemap optimization. These issues limit how effectively search engines and AI systems can understand and recommend your services.",
  },
};

// --- COMPONENTS ---

const AnvilIcon = ({ size = 32, color = COLORS.burntOrange }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="none">
    <rect x="30" y="20" width="40" height="8" rx="2" fill={color} />
    <rect x="46" y="10" width="8" height="14" rx="1" fill={color} />
    <path d="M38 12 L50 0 L62 12" stroke={color} strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 40 L80 40 L90 55 Q92 60 88 62 L12 62 Q8 60 10 55 Z" fill={color} />
    <rect x="35" y="28" width="30" height="14" rx="3" fill={color} />
    <path d="M30 62 L30 82 Q30 88 36 88 L64 88 Q70 88 70 82 L70 62" fill={color} />
    <rect x="38" y="88" width="24" height="6" rx="2" fill={color} />
  </svg>
);

const PageBreak = () => (
  <div
    style={{
      pageBreakAfter: "always",
      breakAfter: "page",
      height: 0,
      margin: 0,
    }}
  />
);

const SectionHeader = ({ number, title, subtitle }) => (
  <div style={{ marginBottom: 20, marginTop: 28 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
      <span
        style={{
          fontFamily: "Oswald, sans-serif",
          fontSize: 11,
          fontWeight: 700,
          color: COLORS.white,
          background: COLORS.burntOrange,
          borderRadius: 4,
          padding: "2px 10px",
          letterSpacing: 1,
          textTransform: "uppercase",
        }}
      >
        {number}
      </span>
      <span
        style={{
          fontFamily: "Oswald, sans-serif",
          fontSize: 22,
          fontWeight: 600,
          color: COLORS.charcoal,
          letterSpacing: 0.5,
        }}
      >
        {title}
      </span>
    </div>
    {subtitle && (
      <p style={{ fontFamily: "Inter, sans-serif", fontSize: 12, color: COLORS.graphite, margin: 0, marginLeft: 46 }}>
        {subtitle}
      </p>
    )}
    <div style={{ height: 2, background: `linear-gradient(90deg, ${COLORS.burntOrange}, transparent)`, marginTop: 8 }} />
  </div>
);

const MetricCard = ({ label, value, sublabel, accent = false }) => (
  <div
    style={{
      flex: 1,
      background: accent ? COLORS.charcoal : COLORS.white,
      borderRadius: 8,
      padding: "16px 18px",
      border: accent ? "none" : `1px solid ${COLORS.lightGray}`,
      minWidth: 140,
    }}
  >
    <div
      style={{
        fontFamily: "Oswald, sans-serif",
        fontSize: 28,
        fontWeight: 700,
        color: accent ? COLORS.burntOrange : COLORS.charcoal,
        lineHeight: 1.1,
      }}
    >
      {value}
    </div>
    <div
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: 11,
        color: accent ? COLORS.boneWhite : COLORS.graphite,
        marginTop: 4,
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </div>
    {sublabel && (
      <div
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 10,
          color: accent ? "#999" : COLORS.graphite,
          marginTop: 2,
        }}
      >
        {sublabel}
      </div>
    )}
  </div>
);

const RiskBadge = ({ level }) => {
  const colors = {
    critical: { bg: "#FEF2F2", text: COLORS.redAlert, border: "#FECACA" },
    high: { bg: "#FFFBEB", text: COLORS.yellowWarn, border: "#FDE68A" },
    medium: { bg: "#F0F9FF", text: COLORS.steelBlue, border: "#BAE6FD" },
  };
  const c = colors[level] || colors.medium;
  return (
    <span
      style={{
        fontFamily: "Inter, sans-serif",
        fontSize: 10,
        fontWeight: 600,
        color: c.text,
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 4,
        padding: "2px 8px",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {level}
    </span>
  );
};

const GradeCircle = ({ grade }) => {
  const gradeColor =
    grade.startsWith("A") ? COLORS.greenGood : grade.startsWith("B") ? COLORS.steelBlue : grade.startsWith("C") ? COLORS.yellowWarn : COLORS.redAlert;
  return (
    <div
      style={{
        width: 72,
        height: 72,
        borderRadius: "50%",
        border: `4px solid ${gradeColor}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Oswald, sans-serif",
        fontSize: 32,
        fontWeight: 700,
        color: gradeColor,
        flexShrink: 0,
      }}
    >
      {grade}
    </div>
  );
};

// --- MAIN REPORT ---
export default function MarketPositionReport() {
  const d = REPORT_DATA;
  const [isPrintMode] = useState(false);

  return (
    <div
      style={{
        background: COLORS.boneWhite,
        minHeight: "100vh",
        fontFamily: "Inter, sans-serif",
      }}
    >
      {/* Google Fonts */}
      <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <style>{`
        @media print {
          body { margin: 0; padding: 0; }
          @page { margin: 0.5in; size: letter; }
        }
      `}</style>

      <div
        style={{
          maxWidth: 800,
          margin: "0 auto",
          background: COLORS.white,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        {/* === PAGE 1: COVER === */}
        <div style={{ padding: "48px 48px 40px" }}>
          {/* Header bar */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              marginBottom: 40,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AnvilIcon size={36} />
              <div>
                <div
                  style={{
                    fontFamily: "Oswald, sans-serif",
                    fontSize: 20,
                    fontWeight: 700,
                    color: COLORS.charcoal,
                    letterSpacing: 1,
                    lineHeight: 1,
                  }}
                >
                  FORGE GROWTH
                </div>
                <div style={{ fontSize: 9, color: COLORS.graphite, letterSpacing: 1.5, textTransform: "uppercase", marginTop: 2 }}>
                  Search Intelligence
                </div>
              </div>
            </div>
            <div style={{ textAlign: "right", fontSize: 11, color: COLORS.graphite }}>
              <div>{d.prospect.reportDate}</div>
              <div style={{ color: COLORS.steelBlue, fontWeight: 600 }}>forgegrowth.com</div>
            </div>
          </div>

          {/* Title block */}
          <div
            style={{
              background: COLORS.charcoal,
              borderRadius: 12,
              padding: "40px 44px",
              marginBottom: 36,
            }}
          >
            <div
              style={{
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                color: COLORS.burntOrange,
                textTransform: "uppercase",
                letterSpacing: 2,
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Market Position Report
            </div>
            <div
              style={{
                fontFamily: "Oswald, sans-serif",
                fontSize: 38,
                fontWeight: 700,
                color: COLORS.boneWhite,
                lineHeight: 1.15,
                marginBottom: 12,
              }}
            >
              {d.prospect.company}
            </div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              {[
                { label: "Domain", value: d.prospect.domain },
                { label: "Market", value: d.prospect.market },
                { label: "Industry", value: d.prospect.industry },
              ].map((item) => (
                <div key={item.label}>
                  <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 1 }}>{item.label} </span>
                  <span style={{ fontSize: 13, color: COLORS.boneWhite, fontWeight: 500 }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Revenue exposure callout */}
          <div
            style={{
              background: "#FEF2F2",
              border: `1px solid #FECACA`,
              borderLeft: `4px solid ${COLORS.redAlert}`,
              borderRadius: 8,
              padding: "20px 24px",
              marginBottom: 32,
            }}
          >
            <div
              style={{
                fontFamily: "Oswald, sans-serif",
                fontSize: 14,
                fontWeight: 600,
                color: COLORS.redAlert,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom: 6,
              }}
            >
              Revenue Exposure
            </div>
            <div
              style={{
                fontFamily: "Oswald, sans-serif",
                fontSize: 36,
                fontWeight: 700,
                color: COLORS.charcoal,
                lineHeight: 1.1,
                marginBottom: 8,
              }}
            >
              {d.revenueExposure.totalOpportunity}
              <span style={{ fontSize: 16, fontWeight: 400, color: COLORS.graphite, marginLeft: 8 }}>
                estimated annual revenue at risk
              </span>
            </div>
            <p style={{ fontSize: 13, color: COLORS.graphite, margin: 0, lineHeight: 1.6 }}>
              {d.revenueExposure.gapExplanation}
            </p>
          </div>

          {/* Snapshot metrics */}
          <SectionHeader number="01" title="Market Visibility Snapshot" />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <MetricCard label="Visibility Score" value={`${d.marketPosition.visibilityScore}/100`} sublabel="Very Low" accent />
            <MetricCard label="Keywords Tracked" value={d.marketPosition.totalKeywordsTracked.toLocaleString()} />
            <MetricCard label="Currently Ranking" value={d.marketPosition.keywordsRanking} sublabel={`${((d.marketPosition.keywordsRanking / d.marketPosition.totalKeywordsTracked) * 100).toFixed(1)}% of market`} />
            <MetricCard label="Top 10 Positions" value={d.marketPosition.top10} sublabel="High-visibility terms" />
          </div>
        </div>

        <PageBreak />

        {/* === PAGE 2: COMPETITIVE LANDSCAPE + GAPS === */}
        <div style={{ padding: "40px 48px" }}>
          {/* Mini header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 28, paddingBottom: 12, borderBottom: `1px solid ${COLORS.lightGray}` }}>
            <AnvilIcon size={20} />
            <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 13, color: COLORS.graphite, letterSpacing: 1 }}>
              FORGE GROWTH
            </span>
            <span style={{ fontSize: 11, color: COLORS.graphite, marginLeft: "auto" }}>
              {d.prospect.domain} — Market Position Report
            </span>
          </div>

          <SectionHeader
            number="02"
            title="Competitive Landscape"
            subtitle="Top competitors by organic search presence in your market"
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 32 }}>
            {d.competitors.map((comp, i) => (
              <div
                key={comp.name}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 16,
                  background: COLORS.boneWhite,
                  borderRadius: 8,
                  padding: "14px 18px",
                  border: `1px solid ${COLORS.lightGray}`,
                }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: COLORS.steelBlue,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "Oswald, sans-serif",
                    fontSize: 14,
                    fontWeight: 700,
                    color: COLORS.white,
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: "Inter, sans-serif", fontSize: 14, fontWeight: 600, color: COLORS.charcoal }}>
                    {comp.name}
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.graphite, marginTop: 2 }}>{comp.strength}</div>
                  <div style={{ fontSize: 11, color: COLORS.steelBlue, marginTop: 4 }}>
                    Key terms: {comp.keyTerms}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <SectionHeader
            number="03"
            title="Authority Gaps"
            subtitle="High-value search terms where competitors dominate and you're invisible"
          />

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
              }}
            >
              <thead>
                <tr>
                  {["Topic", "Your Status", "Top Competitor", "Search Volume", "Est. Revenue", "Risk"].map((h) => (
                    <th
                      key={h}
                      style={{
                        background: COLORS.charcoal,
                        color: COLORS.boneWhite,
                        padding: "10px 12px",
                        textAlign: "left",
                        fontWeight: 600,
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.authorityGaps.map((gap, i) => (
                  <tr key={gap.topic} style={{ background: i % 2 === 0 ? COLORS.white : COLORS.boneWhite }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600, color: COLORS.charcoal }}>{gap.topic}</td>
                    <td style={{ padding: "10px 12px", color: gap.status === "Absent" ? COLORS.redAlert : COLORS.yellowWarn, fontWeight: 600 }}>
                      {gap.status}
                    </td>
                    <td style={{ padding: "10px 12px", color: COLORS.graphite }}>{gap.competitor}</td>
                    <td style={{ padding: "10px 12px", color: COLORS.charcoal, fontWeight: 500 }}>{gap.volume}</td>
                    <td style={{ padding: "10px 12px", color: COLORS.charcoal, fontWeight: 600 }}>{gap.revenue}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <RiskBadge level={gap.risk} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <PageBreak />

        {/* === PAGE 3: STRUCTURAL RISK + TECH GRADE + CTA === */}
        <div style={{ padding: "40px 48px" }}>
          {/* Mini header */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 28, paddingBottom: 12, borderBottom: `1px solid ${COLORS.lightGray}` }}>
            <AnvilIcon size={20} />
            <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 13, color: COLORS.graphite, letterSpacing: 1 }}>
              FORGE GROWTH
            </span>
            <span style={{ fontSize: 11, color: COLORS.graphite, marginLeft: "auto" }}>
              {d.prospect.domain} — Market Position Report
            </span>
          </div>

          <SectionHeader
            number="04"
            title="Biggest Structural Risk"
            subtitle="The single issue costing you the most revenue right now"
          />

          <div
            style={{
              background: COLORS.charcoal,
              borderRadius: 10,
              padding: "28px 32px",
              marginBottom: 36,
              borderLeft: `5px solid ${COLORS.burntOrange}`,
            }}
          >
            <div
              style={{
                fontFamily: "Oswald, sans-serif",
                fontSize: 20,
                fontWeight: 600,
                color: COLORS.burntOrange,
                marginBottom: 10,
              }}
            >
              {d.structuralRisk.title}
            </div>
            <p
              style={{
                fontSize: 13,
                color: COLORS.boneWhite,
                lineHeight: 1.7,
                margin: 0,
              }}
            >
              {d.structuralRisk.description}
            </p>
          </div>

          <SectionHeader number="05" title="Technical Health" subtitle="Overall site health grade based on automated crawl analysis" />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 24,
              background: COLORS.boneWhite,
              borderRadius: 10,
              padding: "24px 28px",
              border: `1px solid ${COLORS.lightGray}`,
              marginBottom: 48,
            }}
          >
            <GradeCircle grade={d.technicalGrade.grade} />
            <p style={{ fontSize: 13, color: COLORS.graphite, lineHeight: 1.7, margin: 0, flex: 1 }}>
              {d.technicalGrade.summary}
            </p>
          </div>

          {/* CTA */}
          <div
            style={{
              background: `linear-gradient(135deg, ${COLORS.steelBlue}, #2A4A7F)`,
              borderRadius: 12,
              padding: "36px 40px",
              textAlign: "center",
              marginBottom: 40,
            }}
          >
            <div
              style={{
                fontFamily: "Oswald, sans-serif",
                fontSize: 24,
                fontWeight: 700,
                color: COLORS.white,
                marginBottom: 10,
              }}
            >
              Want the Full Analysis?
            </div>
            <p
              style={{
                fontSize: 14,
                color: "rgba(255,255,255,0.85)",
                lineHeight: 1.6,
                margin: "0 auto 20px",
                maxWidth: 520,
              }}
            >
              This report covers where you stand. The full Market Position Analysis includes a prioritized action plan,
              content architecture strategy, detailed technical audit, and a 90-day roadmap to start capturing the revenue
              your competitors are taking.
            </p>
            <div
              style={{
                display: "inline-block",
                background: COLORS.burntOrange,
                color: COLORS.white,
                fontFamily: "Oswald, sans-serif",
                fontSize: 16,
                fontWeight: 600,
                padding: "12px 32px",
                borderRadius: 8,
                letterSpacing: 0.5,
              }}
            >
              Schedule a 15-Minute Review →
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", marginTop: 10 }}>
              matt@forgegrowth.com &nbsp;|&nbsp; forgegrowth.com
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              borderTop: `1px solid ${COLORS.lightGray}`,
              paddingTop: 16,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AnvilIcon size={16} />
              <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 11, color: COLORS.graphite, letterSpacing: 1 }}>
                FORGE GROWTH
              </span>
            </div>
            <div style={{ fontSize: 10, color: COLORS.graphite }}>
              AI-Powered Search Intelligence for Service Businesses
            </div>
            <div style={{ fontSize: 10, color: COLORS.graphite }}>
              Confidential — Prepared for {d.prospect.company}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
