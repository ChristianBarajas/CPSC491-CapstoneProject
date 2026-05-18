import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getCurrentUser } from "../services/authApi";
import { deleteSavedBuild, fetchSavedBuilds } from "../services/buildApi";
import {
  getSavedBuildsForUser,
  removeSavedBuildForUser,
} from "../services/savedBuilds";
import "../styles/SavedBuild.css";

// CPU architecture scores for client-side performance calculation
const CPU_ARCH_SCORES = {
  'Zen 5': 100, 'Zen 4': 90, 'Zen 3': 75, 'Zen 2': 60, 'Zen+': 45, 'Zen': 40,
  'Arrow Lake': 95, 'Raptor Lake Refresh': 90, 'Raptor Lake': 85,
  'Alder Lake': 80, 'Rocket Lake': 70, 'Comet Lake': 60,
  'Coffee Lake Refresh': 55, 'Coffee Lake': 50, 'Kaby Lake': 40, 'Skylake': 35,
};

const GPU_TIER_SCORES = {
  'RTX 5090': 100, 'RTX 5080': 90, 'RTX 5070 Ti': 80, 'RTX 5070': 72,
  'RTX 4090': 95, 'RTX 4080': 82, 'RTX 4070 Ti': 72, 'RTX 4070': 62,
  'RTX 4060 Ti': 50, 'RTX 4060': 45,
  'RTX 3090': 75, 'RTX 3080': 68, 'RTX 3070': 55, 'RTX 3060 Ti': 48, 'RTX 3060': 42,
  'RX 9070 XT': 82, 'RX 9070': 72, 'RX 9060': 55,
  'RX 7900 XTX': 85, 'RX 7900 XT': 78, 'RX 7800 XT': 65, 'RX 7700 XT': 55, 'RX 7600': 40,
  'RX 6900 XT': 65, 'RX 6800 XT': 60, 'RX 6700 XT': 45, 'RX 6600': 32,
};

function calcPerformanceScore(parts) {
  if (!parts) return 0;

  // CPU score
  let cpuScore = 30;
  if (parts.cpu?.name) {
    const name = parts.cpu.name;
    for (const [arch, score] of Object.entries(CPU_ARCH_SCORES)) {
      if (name.includes(arch.replace(' ', ''))) { cpuScore = score * 0.5; break; }
    }
    // Boost from core count / clock hints in name
    if (name.includes('X3D')) cpuScore += 15;
    if (name.match(/i9|9950|9900|7950/)) cpuScore = Math.max(cpuScore, 45);
    if (name.match(/i7|9800|9700|7800|7700/)) cpuScore = Math.max(cpuScore, 38);
    if (name.match(/i5|9600|7600|5600/)) cpuScore = Math.max(cpuScore, 30);
  }

  // GPU score
  let gpuScore = 25;
  if (parts.gpu?.name) {
    const name = parts.gpu.name;
    for (const [chip, score] of Object.entries(GPU_TIER_SCORES)) {
      if (name.includes(chip)) { gpuScore = score; break; }
    }
  }

  // RAM score
  let ramScore = 50;
  if (parts.ram?.name) {
    const name = parts.ram.name;
    if (name.includes('DDR5')) ramScore += 30;
    else if (name.includes('DDR4')) ramScore += 15;
    const speedMatch = name.match(/(\d{4,5})/);
    if (speedMatch) {
      const speed = parseInt(speedMatch[1]);
      if (speed >= 6000) ramScore += 20;
      else if (speed >= 4800) ramScore += 10;
      else if (speed >= 3600) ramScore += 8;
      else if (speed >= 3200) ramScore += 5;
    }
    ramScore = Math.min(100, ramScore);
  }

  return Math.round((cpuScore * 0.35) + (gpuScore * 0.50) + (ramScore * 0.15));
}

const EXAMPLE_BUILDS = [
  {
    id: "demo-1",
    title: "Balanced 1080p Starter",
    createdAt: "2026-03-15T14:30:00.000Z",
    totalPrice: 897,
    budget: 1000,
    compatible: true,
    performanceScore: 74,
    parts: {
      cpu: { name: "Ryzen 5 5600X" },
      gpu: { name: "RTX 3060" },
      ram: { name: "16GB DDR4 3200MHz" },
      mobo: { name: "ROG STRIX B550-F" },
      psu: { name: "Focus GX-650" },
    },
  },
  {
    id: "demo-2",
    title: "Creator Midrange Build",
    createdAt: "2026-03-14T19:05:00.000Z",
    totalPrice: 1325,
    budget: 1400,
    compatible: true,
    performanceScore: 86,
    parts: {
      cpu: { name: "Intel i7-12700K" },
      gpu: { name: "RTX 4070" },
      ram: { name: "32GB DDR5 6000MHz" },
      mobo: { name: "MSI PRO Z690-A" },
      psu: { name: "Corsair RM750e" },
    },
  },
  {
    id: "demo-3",
    title: "High FPS Competitive",
    createdAt: "2026-03-13T09:48:00.000Z",
    totalPrice: 1750,
    budget: 1800,
    compatible: true,
    performanceScore: 92,
    parts: {
      cpu: { name: "Ryzen 7 7800X3D" },
      gpu: { name: "RTX 4070 Ti SUPER" },
      ram: { name: "32GB DDR5 6000MHz" },
      mobo: { name: "Gigabyte B650 AORUS Elite" },
      psu: { name: "Seasonic Focus GX-850" },
    },
  },
];

function BuildCard({ build, onDelete, canDelete }) {
  return (
    <article className="saved-card">
      <header className="saved-card__header">
        <div>
          <h3>{build.title || "Saved Build"}</h3>
          <p>{new Date(build.createdAt).toLocaleString()}</p>
        </div>
        {canDelete ? (
          <button type="button" className="saved-card__remove" onClick={() => onDelete(build.id)}>
            Remove
          </button>
        ) : null}
      </header>

      <div className="saved-card__meta">
        <span>Total: ${build.totalPrice ?? 0}</span>
        <span>Budget: ${build.budget ?? 0}</span>
        <span>{build.compatible ? "Compatible" : "Has Issues"}</span>
      </div>

      <ul className="saved-card__parts">
        {Object.entries(build.parts ?? {}).map(([name, part]) => (
          <li key={name}>
            <strong>{name.toUpperCase()}:</strong> {part?.name ?? "N/A"}
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function SavedBuild() {
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [isLocalFallback, setIsLocalFallback] = useState(false);
  const [user, setUser] = useState(null);
  const [builds, setBuilds] = useState([]);

  useEffect(() => {
    async function loadDashboard() {
      setStatus("loading");
      setError("");
      setIsDemoMode(false);
      setIsLocalFallback(false);

      try {
        const currentUser = await getCurrentUser();

        if (!currentUser) {
          setStatus("signedOut");
          return;
        }

        setUser(currentUser);
        try {
          setBuilds(await fetchSavedBuilds());
        } catch (buildError) {
          setBuilds(getSavedBuildsForUser(currentUser));
          setError(buildError.message || "Unable to load synced builds");
          setIsLocalFallback(true);
        }
        setStatus("ready");
      } catch (e) {
        setError(e.message || "Unable to connect to backend");
        setUser(null);
        setBuilds(EXAMPLE_BUILDS);
        setIsDemoMode(true);
        setStatus("ready");
      }
    }

    loadDashboard();
  }, []);

  const summaryText = useMemo(() => {
    if (isDemoMode) {
      return `${builds.length} example build${builds.length === 1 ? "" : "s"}`;
    }

    if (builds.length === 0) {
      return "No saved builds yet. Head to the build page and save your first one.";
    }

    return `${builds.length} saved build${builds.length === 1 ? "" : "s"}`;
  }, [builds, isDemoMode]);

  const handleDelete = (buildId) => {
    if (!user) return;

    if (isLocalFallback) {
      removeSavedBuildForUser(user, buildId);
      setBuilds((current) => current.filter((build) => build.id !== buildId));
      return;
    }

    deleteSavedBuild(buildId)
      .then(() => {
        setBuilds((current) => current.filter((build) => build.id !== buildId));
      })
      .catch((deleteError) => {
        setError(deleteError.message || "Unable to delete build right now");
      });
  };

  return (
    <div className="saved-page">
      <div className="saved-shell">
        <header className="saved-header">
          <h1>Saved Builds</h1>
          {status === "ready" ? <p>{summaryText}</p> : null}
        </header>

        {status === "loading" ? <p className="saved-status">Loading dashboard...</p> : null}

        {status === "signedOut" ? (
          <section className="saved-empty">
            <h2>Sign in to view your dashboard</h2>
            <p>
              Saved builds are tied to your account so you can find them later on any device.
            </p>
            <div className="saved-empty__actions">
              <Link to="/login" className="saved-btn saved-btn--primary">
                Log In
              </Link>
              <Link to="/build" className="saved-btn saved-btn--secondary">
                Start Building
              </Link>
            </div>
          </section>
        ) : null}

        {isDemoMode ? (
          <p className="saved-status saved-status--demo">
            Backend unavailable, showing example dashboard data for demo mode.
          </p>
        ) : null}

        {status === "error" ? <p className="saved-status saved-status--error">{error}</p> : null}

        {status === "ready" && builds.length === 0 ? (
          <section className="saved-empty">
            <h2>No saved builds yet</h2>
            <p>Create a build and click Save This Build to add it here.</p>
            <Link to="/build" className="saved-btn saved-btn--primary">
              Create a Build
            </Link>
          </section>
        ) : null}

        {status === "ready" && builds.length > 0 ? (
          <section className="saved-grid">
            {builds.map((build) => (
              <BuildCard
                key={build.id}
                build={build}
                onDelete={handleDelete}
                canDelete={!isDemoMode}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
