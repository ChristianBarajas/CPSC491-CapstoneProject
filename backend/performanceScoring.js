/**
 * Performance Scoring Engine
 * Calculates a 0-100 performance score based on component specs
 */

// CPU benchmark approximations based on architecture and specs
const CPU_ARCH_SCORES = {
  'Zen 5': 100,
  'Zen 4': 90,
  'Zen 3': 75,
  'Zen 2': 60,
  'Zen+': 45,
  'Zen': 40,
  'Arrow Lake': 95,
  'Raptor Lake Refresh': 90,
  'Raptor Lake': 85,
  'Alder Lake': 80,
  'Rocket Lake': 70,
  'Comet Lake': 60,
  'Coffee Lake Refresh': 55,
  'Coffee Lake': 50,
  'Kaby Lake': 40,
  'Skylake': 35,
};

// GPU chipset tier scores (approximate relative performance)
const GPU_TIER_SCORES = {
  // NVIDIA RTX 50 series
  'GeForce RTX 5090': 100,
  'GeForce RTX 5080': 90,
  'GeForce RTX 5070 Ti': 80,
  'GeForce RTX 5070': 72,
  'GeForce RTX 5060 Ti': 60,
  'GeForce RTX 5060': 52,
  // NVIDIA RTX 40 series
  'GeForce RTX 4090': 95,
  'GeForce RTX 4080 SUPER': 85,
  'GeForce RTX 4080': 82,
  'GeForce RTX 4070 Ti SUPER': 75,
  'GeForce RTX 4070 Ti': 72,
  'GeForce RTX 4070 SUPER': 68,
  'GeForce RTX 4070': 62,
  'GeForce RTX 4060 Ti': 50,
  'GeForce RTX 4060': 45,
  // NVIDIA RTX 30 series
  'GeForce RTX 3090 Ti': 78,
  'GeForce RTX 3090': 75,
  'GeForce RTX 3080 Ti': 72,
  'GeForce RTX 3080 12GB': 70,
  'GeForce RTX 3080 10GB': 68,
  'GeForce RTX 3070 Ti': 60,
  'GeForce RTX 3070': 55,
  'GeForce RTX 3060 Ti': 48,
  'GeForce RTX 3060 12GB': 42,
  'GeForce RTX 3050 8GB': 30,
  'GeForce RTX 3050 6GB': 25,
  // AMD RX 9000 series
  'Radeon RX 9070 XT': 82,
  'Radeon RX 9070': 72,
  'Radeon RX 9060 XT': 55,
  // AMD RX 7000 series
  'Radeon RX 7900 XTX': 85,
  'Radeon RX 7900 XT': 78,
  'Radeon RX 7800 XT': 65,
  'Radeon RX 7700 XT': 55,
  'Radeon RX 7600 XT': 45,
  'Radeon RX 7600': 40,
  // AMD RX 6000 series
  'Radeon RX 6950 XT': 70,
  'Radeon RX 6900 XT': 65,
  'Radeon RX 6800 XT': 60,
  'Radeon RX 6800': 55,
  'Radeon RX 6750 XT': 48,
  'Radeon RX 6700 XT': 45,
  'Radeon RX 6650 XT': 38,
  'Radeon RX 6600 XT': 35,
  'Radeon RX 6600': 32,
  'Radeon RX 6500 XT': 20,
  // Intel Arc
  'Arc B580': 42,
  'Arc B570': 35,
  'Arc A770': 45,
  'Arc A750': 40,
};

/**
 * Calculate CPU score (0-100)
 */
export function calculateCpuScore(cpu) {
  if (!cpu) return 0;
  
  let score = 0;
  
  // Base score from architecture (0-50 points)
  const archScore = CPU_ARCH_SCORES[cpu.microarchitecture] || 30;
  score += archScore * 0.5;
  
  // Core count bonus (0-25 points)
  const coreCount = cpu.core_count || 4;
  const coreScore = Math.min(coreCount / 24, 1) * 25;
  score += coreScore;
  
  // Boost clock bonus (0-25 points)
  const boostClock = cpu.boost_clock || 3.5;
  const clockScore = Math.min((boostClock - 3.0) / 3.0, 1) * 25;
  score += Math.max(0, clockScore);
  
  return Math.round(Math.min(100, score));
}

/**
 * Calculate GPU score (0-100)
 */
export function calculateGpuScore(gpu) {
  if (!gpu) return 0;
  
  // Try to match chipset
  const chipset = gpu.chipset || gpu.name || '';
  
  // Direct match
  if (GPU_TIER_SCORES[chipset]) {
    return GPU_TIER_SCORES[chipset];
  }
  
  // Partial match - find best matching key
  for (const [key, score] of Object.entries(GPU_TIER_SCORES)) {
    if (chipset.includes(key) || key.includes(chipset)) {
      return score;
    }
  }
  
  // Fallback: estimate from VRAM
  const vram = gpu.memory || 8;
  if (vram >= 24) return 70;
  if (vram >= 16) return 55;
  if (vram >= 12) return 45;
  if (vram >= 8) return 35;
  return 25;
}

/**
 * Calculate RAM score (0-100)
 */
export function calculateRamScore(ram) {
  if (!ram) return 0;
  
  const name = ram.name || '';
  let score = 50; // Base score
  
  // DDR generation
  if (name.includes('DDR5')) {
    score += 30;
  } else if (name.includes('DDR4')) {
    score += 15;
  }
  
  // Speed extraction (e.g., "DDR5-6000" or "DDR4-3600")
  const speedMatch = name.match(/(\d{4,5})/);
  if (speedMatch) {
    const speed = parseInt(speedMatch[1]);
    if (speed >= 6000) score += 20;
    else if (speed >= 5600) score += 15;
    else if (speed >= 4800) score += 10;
    else if (speed >= 3600) score += 8;
    else if (speed >= 3200) score += 5;
  }
  
  // Capacity bonus from name (e.g., "32GB")
  const capacityMatch = name.match(/(\d+)\s*GB/i);
  if (capacityMatch) {
    const capacity = parseInt(capacityMatch[1]);
    if (capacity >= 64) score += 10;
    else if (capacity >= 32) score += 5;
  }
  
  return Math.round(Math.min(100, score));
}

/**
 * Calculate overall build performance score
 * Weighted: CPU 35%, GPU 50%, RAM 15%
 */
export function calculateBuildScore(parts) {
  if (!parts) return 0;
  
  const cpuScore = calculateCpuScore(parts.cpu);
  const gpuScore = calculateGpuScore(parts.gpu);
  const ramScore = calculateRamScore(parts.memory);
  
  // Weighted average (GPU matters most for gaming builds)
  const weightedScore = (cpuScore * 0.35) + (gpuScore * 0.50) + (ramScore * 0.15);
  
  return Math.round(weightedScore);
}
