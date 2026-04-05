# Evolution Simulator

**Real-time multicellular organism evolution using NEAT neural networks.**

A browser-based simulation where organisms with evolvable neural brains compete for survival, develop multicellular body plans, and evolve complex behaviors through natural selection -- all rendered live on HTML5 Canvas.

![Status](https://img.shields.io/badge/status-active_development-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D18-blue)
![License](https://img.shields.io/badge/license-MIT-yellow)

---

## Overview

Each organism starts as a simple cell with a minimal NEAT neural network. Through mutation, crossover, and selection pressure, populations evolve increasingly sophisticated survival strategies: foraging patterns, predator avoidance, combat tactics, and reproduction timing.

The simulation runs server-side with a WebSocket-connected browser client for real-time visualization. You can observe, possess (take manual control of) any organism, and watch neural networks evolve in real time.

---

## Features

### Organisms
- **Multicellular body plans** -- organisms grow up to multiple cells, each with a specialized role
- **5 cell types**: Core (base), Mouth (feeding bonus), Muscle (speed), Sensor (extended vision), Armor (HP tank)
- **Cell properties affect stats** -- speed, sensing range, HP, and eating efficiency scale with body composition

### Neural Brains (NEAT)
- Full **NEAT** (NeuroEvolution of Augmenting Topologies) implementation
- 8 sensory inputs: bias, energy level, food direction/distance, agent direction/distance, touch detection, persistent memory
- 4 outputs: accelerate, rotate, eat, reproduce
- Topology evolution: add/remove nodes, add/remove connections, weight mutation
- **Crossover reproduction** between fit parents with innovation-number-based gene alignment
- Seed connections for basic survival (move toward food, eat on contact)

### Ecosystem
- **4 food types**: Plankton (common, low energy), Algae (grows in clusters), Meat (dropped on death), Fruit (rare, terrain-locked, high energy)
- Dynamic food growth -- plankton scales with population, algae spreads from parents, fruit spawns on specific terrain
- Population-responsive ecosystem prevents starvation spirals and overpopulation

### World
- Circular map (800px radius) with procedurally generated terrain
- **2 terrain types**: Land and water zones affecting fruit spawns
- **Spatial grid optimization** for efficient neighbor queries (O(1) average lookup)

### Interaction
- **Possess mode** -- take direct WASD/arrow-key control of any organism
- Real-time stats dashboard: population, generation, fitness metrics, neural network complexity
- Simulation speed control (pause, 1x-10x)
- Auto-save/load with versioned save files
- **Health monitoring** via `monitor.js` watchdog

### Combat & Death
- Organisms can eat smaller organisms (phagocytosis)
- Dead organisms drop meat for scavengers
- Energy-based lifecycle: starvation kills, reproduction costs energy
- Kill tracking and fitness scoring (food eaten + kills + age + cell count)

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Node.js + Express |
| Real-time | WebSocket (`ws`) |
| Rendering | HTML5 Canvas (client-side) |
| AI | Custom NEAT implementation (server-side) |
| Monitoring | Custom watchdog (`monitor.js`) |

---

## Quick Start

```bash
# Clone
git clone https://github.com/Lordof2L/evolution-sim.git
cd evolution-sim

# Install dependencies
npm install

# Run
npm start
# or
./start.sh
```

Open `http://localhost:3333` in your browser.

### Controls

| Key | Action |
|-----|--------|
| Click organism | Select / view details |
| `P` | Possess selected organism |
| `W/A/S/D` or Arrows | Move (when possessing) |
| `E` or Space | Eat (when possessing) |
| `R` | Reproduce (when possessing) |
| Speed slider | Adjust simulation speed |

---

## Architecture

```
Server (Node.js)
  |
  |-- NEAT Engine        # Brain creation, mutation, crossover
  |-- Simulation Loop     # 30 tick/s physics, sensing, decisions
  |-- Spatial Grid        # O(1) neighbor queries
  |-- Food Ecosystem      # Dynamic growth, terrain-aware spawning
  |-- Save/Load           # Versioned JSON persistence
  |
  WebSocket
  |
Client (Browser)
  |-- Canvas Renderer     # Organisms, food, terrain, UI
  |-- Stats Dashboard     # Population, fitness, NN complexity
  |-- Possess Controls    # Direct organism control
```

---

## Screenshots

> *Coming soon -- simulation in action*

---

## Author

**Lukas Litvak** -- [@Lordof2L](https://github.com/Lordof2L)

---

## License

MIT
