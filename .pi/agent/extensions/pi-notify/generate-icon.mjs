/**
 * Generate Pi Mascot Icon
 * 
 * Creates a PNG icon of the Pi mascot with transparent background.
 * Based on the mascot from custom-header.ts
 */

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Icon size (square)
const SIZE = 256;
const BLOCK_SIZE = SIZE / 16; // Grid-based design

// Colors
const PI_BLUE = '#50B4E6'; // RGB(80, 180, 230) - 3b1b Blue
const WHITE = '#FFFFFF';
const BLACK = '#1A1A1A';

const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

// Transparent background
ctx.clearRect(0, 0, SIZE, SIZE);

// Helper to draw a block at grid position
function drawBlock(gridX, gridY, color, widthBlocks = 1, heightBlocks = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(
    gridX * BLOCK_SIZE,
    gridY * BLOCK_SIZE,
    widthBlocks * BLOCK_SIZE,
    heightBlocks * BLOCK_SIZE
  );
}

// --- Draw the Pi mascot ---

// Eyes (row 3, matching the ASCII art positioning)
// Left eye: white block + black pupil
drawBlock(4, 3, WHITE);      // Left eye white
drawBlock(5, 3, BLACK, 0.5); // Left eye pupil (half block)

// Right eye: white block + black pupil  
drawBlock(9, 3, WHITE);       // Right eye white
drawBlock(10, 3, BLACK, 0.5); // Right eye pupil (half block)

// Top bar / overhang (row 4-5) - 14 blocks wide, centered
// Starting at grid position 1, width 14
drawBlock(1, 5, PI_BLUE, 14, 2);

// Left leg (rows 7-14) - 2 blocks wide
drawBlock(4, 7, PI_BLUE, 2, 8);

// Right leg (rows 7-14) - 2 blocks wide  
drawBlock(10, 7, PI_BLUE, 2, 8);

// Save the icon
const buffer = canvas.toBuffer('image/png');
const outputPath = join(__dirname, 'pi-icon.png');
writeFileSync(outputPath, buffer);

console.log(`Icon saved to: ${outputPath}`);
