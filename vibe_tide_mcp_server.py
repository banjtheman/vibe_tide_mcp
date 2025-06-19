#!/usr/bin/env python
"""
VibeTide MCP Server
A Model Context Protocol server for interacting with VibeTide levels.

Provides tools for:
- Viewing level data and visualizations
- Playing levels in the web player
- Editing levels (entire level, single row, or single spot)
- Creating new levels with AI
- Decoding levels from URLs

Compatible with any MCP client.
"""

import base64
import io
import json
import logging
import os
import tempfile
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
from PIL import Image, ImageDraw, ImageFont

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastMCP server
mcp = FastMCP("vibe-tide-server")

# VibeTide configuration - only web player needed
VIBE_TIDE_CONFIG = {
    "web_player_url": "https://vibetideplayer.banjtheman.xyz/",
}

# Tile type mappings
TILE_TYPES = {
    0: {"name": "Empty", "symbol": "⬜", "description": "Walkable air space"},
    1: {"name": "Grass", "symbol": "🌱", "description": "Standard ground platform"},
    2: {"name": "Rock", "symbol": "🗿", "description": "Solid stone platform"},
    3: {"name": "Yellow", "symbol": "⭐", "description": "Special yellow platform"},
    4: {"name": "Ice", "symbol": "❄️", "description": "Slippery ice platform"},
    5: {"name": "Red", "symbol": "🔥", "description": "Dangerous red platform"},
    6: {"name": "Spikes", "symbol": "⚠️", "description": "Hazardous spikes"},
    7: {"name": "Water", "symbol": "💧", "description": "Water tiles"},
}

# Tile colors matching the web builder
TILE_COLORS = {
    0: (249, 250, 251),  # Empty - light gray
    1: (74, 222, 128),  # Grass - green
    2: (107, 114, 128),  # Rock - gray
    3: (250, 204, 21),  # Yellow - yellow
    4: (56, 189, 248),  # Ice - light blue
    5: (239, 68, 68),  # Fire/Red - red
    6: (139, 92, 246),  # Spikes - purple
    7: (6, 182, 212),  # Water - cyan
}

# Border colors for tiles
TILE_BORDER_COLORS = {
    0: (229, 231, 235),  # Empty tiles get a light border
    1: (34, 197, 94),  # Slightly darker versions for borders
    2: (75, 85, 99),
    3: (217, 171, 3),
    4: (2, 132, 199),
    5: (220, 38, 38),
    6: (124, 58, 237),
    7: (8, 145, 178),
}

# Tile labels for small tiles
TILE_LABELS = {0: "", 1: "G", 2: "R", 3: "Y", 4: "I", 5: "F", 6: "S", 7: "W"}


class LevelEncoder:
    """Fast level encoding/decoding without agent tools"""

    def __init__(self):
        # Character mapping for tiles (URL-safe)
        self.tile_chars = {
            0: ".",  # Empty - most common
            1: "G",  # Grass
            2: "R",  # Rock
            3: "Y",  # Yellow
            4: "I",  # Ice
            5: "F",  # Fire/Red
            6: "S",  # Spikes
            7: "W",  # Water
        }
        self.char_tiles = {char: tile for tile, char in self.tile_chars.items()}

    def encode(self, level_data: Dict[str, Any]) -> str:
        """Encode level data to URL-safe string"""
        try:
            tiles = level_data.get("tiles", [])
            if not tiles:
                raise ValueError("No tiles found")

            height = len(tiles)
            width = len(tiles[0]) if tiles else 0

            # Convert 2D array to character string
            tile_string = ""
            for row in tiles:
                for tile in row:
                    tile_string += self.tile_chars.get(tile, ".")

            # Apply run-length encoding for empty tiles
            tile_string = self._run_length_encode(tile_string)

            # Create base format
            encoded = f"{width}x{height}:{tile_string}"

            # Add game parameters if provided
            params = {}
            for param in ["maxEnemies", "enemySpawnChance", "coinSpawnChance"]:
                if param in level_data and level_data[param] is not None:
                    params[param] = level_data[param]

            if params:
                params_json = json.dumps(params)
                encoded += f"|{self._base64url_encode(params_json)}"

            return self._base64url_encode(encoded)

        except Exception as e:
            logger.error(f"Failed to encode level: {e}")
            raise ValueError(f"Level encoding failed: {str(e)}")

    def decode(self, encoded_string: str) -> Dict[str, Any]:
        """Decode URL-safe string back to level data"""
        try:
            encoded_string = encoded_string.strip()
            if not encoded_string:
                raise ValueError("Empty encoded string")

            # Decode from base64url
            decoded = self._base64url_decode(encoded_string)

            # Parse parameters if present
            main_data = decoded
            game_params = {}

            if "|" in decoded:
                parts = decoded.split("|", 1)
                if len(parts) == 2:
                    main_data, params_data = parts
                    try:
                        params_json = self._base64url_decode(params_data)
                        game_params = json.loads(params_json)
                    except Exception as e:
                        logger.warning(f"Failed to parse parameters: {e}")

            # Parse format: widthxheight:encoded_data
            if ":" not in main_data:
                raise ValueError("Invalid format: missing colon")

            dimensions, tile_data = main_data.split(":", 1)

            if "x" not in dimensions:
                raise ValueError("Invalid format: missing dimensions")

            width, height = map(int, dimensions.split("x"))

            if width < 1 or height < 1:
                raise ValueError(f"Invalid dimensions: {width}x{height}")

            # Decode run-length encoding
            tile_string = self._run_length_decode(tile_data)

            # Convert back to 2D array
            tiles = []
            index = 0

            for y in range(height):
                tiles.append([])
                for x in range(width):
                    char = tile_string[index] if index < len(tile_string) else "."
                    tiles[y].append(self.char_tiles.get(char, 0))
                    index += 1

            result = {
                "tiles": tiles,
                "width": width,
                "height": height,
                "name": self._generate_level_name(tiles),
            }

            # Add game parameters
            for param in ["maxEnemies", "enemySpawnChance", "coinSpawnChance"]:
                if param in game_params:
                    result[param] = game_params[param]

            return result

        except Exception as e:
            logger.error(f"Failed to decode level: {e}")
            raise ValueError(f"Level decoding failed: {str(e)}")

    def _run_length_encode(self, s: str) -> str:
        """Run-length encoding for repeated empty tiles"""
        if not s:
            return s

        result = ""
        count = 1
        current = s[0]

        for i in range(1, len(s)):
            if s[i] == current and current == ".":
                count += 1
            else:
                if current == "." and count > 2:
                    result += f".{count}"
                else:
                    result += current * count
                current = s[i]
                count = 1

        # Handle final sequence
        if current == "." and count > 2:
            result += f".{count}"
        else:
            result += current * count

        return result

    def _run_length_decode(self, s: str) -> str:
        """Decode run-length encoding"""
        result = ""
        i = 0

        while i < len(s):
            char = s[i]

            if char == "." and i + 1 < len(s) and s[i + 1].isdigit():
                # Extract number
                num_str = ""
                j = i + 1
                while j < len(s) and s[j].isdigit():
                    num_str += s[j]
                    j += 1
                count = int(num_str)
                result += "." * count
                i = j
            else:
                result += char
                i += 1

        return result

    def _base64url_encode(self, s: str) -> str:
        """URL-safe base64 encoding"""
        encoded = base64.b64encode(s.encode("utf-8")).decode("ascii")
        return encoded.replace("+", "-").replace("/", "_").rstrip("=")

    def _base64url_decode(self, s: str) -> str:
        """URL-safe base64 decoding"""
        try:
            # Add padding if necessary
            padding = (4 - len(s) % 4) % 4
            s += "=" * padding
            s = s.replace("-", "+").replace("_", "/")

            decoded_bytes = base64.b64decode(s)
            return decoded_bytes.decode("utf-8")
        except Exception as e:
            logger.error(f"Base64 decode error: {e}")
            raise ValueError(f"Invalid base64 encoding: {str(e)}")

    def _generate_level_name(self, tiles: List[List[int]]) -> str:
        """Generate a name based on level content"""
        stats = self._analyze_level_content(tiles)

        name = ""
        if stats["water"] > 0.3:
            name += "Aquatic "
        if stats["spikes"] > 0.1:
            name += "Dangerous "
        if stats["ice"] > 0.2:
            name += "Icy "
        if stats["platforms"] < 0.1:
            name += "Minimal "
        if stats["platforms"] > 0.4:
            name += "Dense "

        name += "Adventure"
        return name.strip()

    def _analyze_level_content(self, tiles: List[List[int]]) -> Dict[str, float]:
        """Analyze level content for statistics"""
        if not tiles:
            return {
                "empty": 1.0,
                "platforms": 0.0,
                "ice": 0.0,
                "dangerous": 0.0,
                "spikes": 0.0,
                "water": 0.0,
            }

        total = len(tiles) * len(tiles[0])
        counts = {i: 0 for i in range(8)}

        for row in tiles:
            for tile in row:
                counts[tile] = counts.get(tile, 0) + 1

        return {
            "empty": counts[0] / total,
            "platforms": (counts[1] + counts[2] + counts[3]) / total,
            "ice": counts[4] / total,
            "dangerous": counts[5] / total,
            "spikes": counts[6] / total,
            "water": counts[7] / total,
        }


# Global encoder instance
level_encoder = LevelEncoder()


def extract_json_from_response(response_text: str) -> Dict[str, Any]:
    """Extract JSON from agent response"""
    try:
        # Ensure we have a string
        if not isinstance(response_text, str):
            response_text = str(response_text)

        response_text = response_text.strip()

        # Handle markdown code blocks - strip ``` if present
        if response_text.startswith("```"):
            # Find the JSON content between code blocks
            lines = response_text.split("\n")
            json_lines = []
            in_json = False

            for line in lines:
                if line.strip().startswith("```"):
                    if not in_json:
                        in_json = True
                    else:
                        break  # End of code block
                elif in_json:
                    json_lines.append(line)

            response_text = "\n".join(json_lines).strip()

        # Try to parse entire response as JSON
        try:
            return json.loads(response_text)
        except json.JSONDecodeError as e:
            logger.warning(f"Initial JSON parsing failed: {e}")
            logger.warning(f"Response preview: {response_text[:500]}...")

            # Try to extract JSON from text using regex
            import re

            # Look for JSON objects that contain "tiles"
            json_matches = re.findall(
                r'\{[^{}]*"tiles"[^{}]*\}', response_text, re.DOTALL
            )
            if json_matches:
                logger.info("Found JSON match with regex")
                return json.loads(json_matches[0])

            # Try to find any JSON-like structure
            json_matches = re.findall(r"\{.*?\}", response_text, re.DOTALL)
            if json_matches:
                # Try each match
                for match in json_matches:
                    try:
                        parsed = json.loads(match)
                        if "tiles" in parsed:
                            logger.info("Found valid JSON with tiles in regex match")
                            return parsed
                    except json.JSONDecodeError:
                        continue

            # If all else fails, try to reconstruct from visible structure
            # Look for patterns like "tiles": [[ in the response
            if '"tiles"' in response_text and "[[" in response_text:
                logger.warning("Attempting to reconstruct JSON from partial response")
                # This is a fallback - try to wait for complete response
                raise ValueError(
                    f"JSON appears incomplete - response might be streaming: {response_text[:200]}..."
                )

            raise ValueError(
                f"No valid JSON found in response. Response: {response_text[:200]}..."
            )

    except Exception as e:
        logger.error(f"JSON extraction failed: {e}")
        logger.error(f"Response text: {response_text[:500]}...")
        raise ValueError(f"Failed to extract JSON from response: {str(e)}")


def is_encoded_level(data) -> bool:
    """Check if data is an encoded level string"""
    if isinstance(data, str) and len(data) > 10:
        try:
            # Try to decode it
            level_encoder.decode(data)
            return True
        except:
            return False
    return False


def prepare_level_for_editing(current_level) -> Dict[str, Any]:
    """Prepare level data for editing agent"""
    if current_level is None:
        return None

    # If it's an encoded string, decode it
    if is_encoded_level(current_level):
        return level_encoder.decode(current_level)

    # If it's a dict with encoded level, decode that
    if isinstance(current_level, dict) and "encodedLevel" in current_level:
        return level_encoder.decode(current_level["encodedLevel"])

    # If it's already level data with tiles, return as-is
    if isinstance(current_level, dict) and "tiles" in current_level:
        return current_level

    return None


def visualize_level(level_data: Dict[str, Any]) -> str:
    """Create a visual representation of the level using symbols"""
    tiles = level_data.get("tiles", [])
    if not tiles:
        return "Empty level"

    visualization = []
    visualization.append(f"Level: {level_data.get('name', 'Unnamed')}")
    visualization.append(f"Size: {len(tiles[0])}x{len(tiles)}")

    # Add game parameters if present
    params = []
    if "maxEnemies" in level_data:
        params.append(f"Max Enemies: {level_data['maxEnemies']}")
    if "enemySpawnChance" in level_data:
        params.append(f"Enemy Spawn: {level_data['enemySpawnChance']}%")
    if "coinSpawnChance" in level_data:
        params.append(f"Coin Spawn: {level_data['coinSpawnChance']}%")

    if params:
        visualization.append("Parameters: " + ", ".join(params))

    visualization.append("\nLevel Layout:")
    visualization.append("=" * (len(tiles[0]) + 2))

    for row in tiles:
        row_str = "|"
        for tile in row:
            symbol = TILE_TYPES.get(tile, {"symbol": "?"})["symbol"]
            row_str += symbol
        row_str += "|"
        visualization.append(row_str)

    visualization.append("=" * (len(tiles[0]) + 2))

    # Add legend
    visualization.append("\nTile Legend:")
    for tile_id, tile_info in TILE_TYPES.items():
        visualization.append(
            f"  {tile_info['symbol']} = {tile_info['name']} ({tile_info['description']})"
        )

    return "\n".join(visualization)


def generate_level_image_to_file(
    level_data: Dict[str, Any], tile_size: int = 16, max_width: int = 1200
) -> str:
    """Generate a PNG image of the level and save to a temporary file. Returns the file path."""
    tiles = level_data.get("tiles", [])

    # Create a temporary file
    temp_file = tempfile.NamedTemporaryFile(
        delete=False, suffix=".png", prefix="vibe_tide_level_"
    )
    temp_path = temp_file.name
    temp_file.close()

    if not tiles:
        # Create a small error image
        img = Image.new("RGB", (200, 100), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        draw.text((10, 40), "Empty Level", fill=(0, 0, 0))
        img.save(temp_path, format="PNG")
        return temp_path

    height = len(tiles)
    width = len(tiles[0]) if tiles else 0

    # Calculate image dimensions
    # For very wide levels, make tiles smaller to fit in max_width
    actual_tile_size = min(tile_size, max_width // width) if width > 0 else tile_size
    actual_tile_size = max(4, actual_tile_size)  # Minimum 4px per tile

    img_width = width * actual_tile_size
    img_height = height * actual_tile_size

    # Create image with white background
    img = Image.new("RGB", (img_width, img_height), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Try to load a font for labels (fallback to default if not available)
    try:
        font = ImageFont.truetype("arial.ttf", max(8, actual_tile_size // 2))
    except:
        try:
            font = ImageFont.load_default()
        except:
            font = None

    # Draw tiles
    for y in range(height):
        for x in range(width):
            tile_type = tiles[y][x]

            # Calculate tile position
            left = x * actual_tile_size
            top = y * actual_tile_size
            right = left + actual_tile_size
            bottom = top + actual_tile_size

            # Get colors
            fill_color = TILE_COLORS.get(tile_type, (128, 128, 128))
            border_color = TILE_BORDER_COLORS.get(tile_type, (0, 0, 0))

            # Draw tile background
            draw.rectangle(
                [left, top, right - 1, bottom - 1],
                fill=fill_color,
                outline=border_color,
            )

            # Add label for non-empty tiles if tile is large enough
            if actual_tile_size >= 12 and tile_type != 0:
                label = TILE_LABELS.get(tile_type, str(tile_type))
                if label and font:
                    # Calculate text position (center of tile)
                    bbox = draw.textbbox((0, 0), label, font=font)
                    text_width = bbox[2] - bbox[0]
                    text_height = bbox[3] - bbox[1]
                    text_x = left + (actual_tile_size - text_width) // 2
                    text_y = top + (actual_tile_size - text_height) // 2

                    # Use white text for dark backgrounds, black for light
                    text_color = (255, 255, 255) if sum(fill_color) < 400 else (0, 0, 0)
                    draw.text((text_x, text_y), label, fill=text_color, font=font)

    # Save to temporary file
    img.save(temp_path, format="PNG", optimize=True)
    return temp_path


@mcp.tool()
async def view_level(encoded_level: str) -> Dict[str, Any]:
    """View a VibeTide level with visual representation.

    Args:
        encoded_level: An encoded level string from a URL or sharing link

    Returns a visual representation of the level.
    """
    try:
        # Decode level from string
        level_data = level_encoder.decode(encoded_level)
        play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"

        # Generate visualization
        visualization = visualize_level(level_data)

        return {
            "success": True,
            "level_data": level_data,
            "visualization": visualization,
            "play_url": play_url,
            "message": "Level visualized successfully",
        }

    except Exception as e:
        logger.error(f"Failed to view level: {e}")
        return {"success": False, "error": f"Failed to view level: {str(e)}"}


@mcp.tool()
async def view_level_image(
    encoded_level: str, tile_size: int = 16, max_width: int = 1200
) -> str:
    """View a VibeTide level as a beautiful PNG image with proper colors.

    This generates a much better visual representation than the ASCII version,
    using the same colors as the web builder. The image is saved to a temporary
    file and the file path is returned for MCP clients to display.

    Args:
        encoded_level: An encoded level string from a URL or sharing link
        tile_size: Size of each tile in pixels (default 16, will auto-adjust for wide levels)
        max_width: Maximum image width in pixels (default 1200)

    Returns:
        The file path to the generated PNG image
    """
    try:
        # Decode level from string
        level_data = level_encoder.decode(encoded_level)

        # Generate PNG image to temporary file
        image_path = generate_level_image_to_file(level_data, tile_size, max_width)

        return image_path

    except Exception as e:
        logger.error(f"Failed to generate level image: {e}")
        # Return error as string since we're returning a simple string now
        raise Exception(f"Failed to generate level image: {str(e)}")


@mcp.tool()
async def edit_level_metadata(
    encoded_level: str,
    new_name: Optional[str] = None,
    new_description: Optional[str] = None,
    max_enemies: Optional[int] = None,
    enemy_spawn_chance: Optional[float] = None,
    coin_spawn_chance: Optional[float] = None,
) -> Dict[str, Any]:
    """Edit only the metadata of a VibeTide level without changing the tile layout.

    This is much more efficient than edit_entire_level when you only want to change
    game parameters like enemy count, spawn rates, name, or description.

    Args:
        encoded_level: The encoded level string to modify
        new_name: New name for the level (optional)
        new_description: New description for the level (optional)
        max_enemies: Maximum enemies parameter (0-10, optional)
        enemy_spawn_chance: Enemy spawn chance percentage (0-100, optional)
        coin_spawn_chance: Coin spawn chance percentage (0-100, optional)

    Returns:
        The modified level data with new encoded string
    """
    try:
        # Decode the existing level to get current data
        level_data = level_encoder.decode(encoded_level)

        # Update only the specified parameters (keep existing if not specified)
        if new_name is not None:
            level_data["name"] = new_name
        if new_description is not None:
            level_data["description"] = new_description
        if max_enemies is not None:
            level_data["maxEnemies"] = max_enemies
        if enemy_spawn_chance is not None:
            level_data["enemySpawnChance"] = enemy_spawn_chance
        if coin_spawn_chance is not None:
            level_data["coinSpawnChance"] = coin_spawn_chance

        # Re-encode with the updated metadata
        new_encoded_level = level_encoder.encode(level_data)

        level_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={new_encoded_level}"
        level_data["level_url"] = level_url

        return {
            "success": True,
            "level_data": level_data,
            "encoded_level": new_encoded_level,
            "play_url": level_url,
            "change_summary": "Updated metadata only - tiles unchanged",
            "message": f"Successfully updated level metadata",
        }

    except Exception as e:
        logger.error(f"Failed to edit level metadata: {e}")
        return {"success": False, "error": f"Failed to edit level metadata: {str(e)}"}


@mcp.tool()
async def play_level(encoded_level: str) -> Dict[str, Any]:
    """Get the URL to play a VibeTide level in the web player.

    Args:
        encoded_level: An encoded level string for playing

    Returns a URL to play the level.
    """
    try:
        # Decode level to get name
        try:
            level_data = level_encoder.decode(encoded_level)
            level_name = level_data.get("name", "Unnamed Level")
        except Exception as e:
            return {"success": False, "error": f"Invalid encoded level: {str(e)}"}

        play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"

        return {
            "success": True,
            "play_url": play_url,
            "level_name": level_name,
            "web_player_url": VIBE_TIDE_CONFIG["web_player_url"],
            "message": f"Ready to play '{level_name}' at: {play_url}",
        }

    except Exception as e:
        logger.error(f"Failed to prepare level for playing: {e}")
        return {
            "success": False,
            "error": f"Failed to prepare level for playing: {str(e)}",
        }


@mcp.tool()
async def edit_level_tile(
    encoded_level: str, row: int, col: int, new_tile_type: int
) -> Dict[str, Any]:
    """Edit a single tile in a VibeTide level.

    Args:
        encoded_level: An encoded level string from a URL or sharing link
        row: Row index (0-based, from top)
        col: Column index (0-based, from left)
        new_tile_type: New tile type (0-7, see tile legend)

    Returns the modified level data with the single tile changed.
    """
    try:
        # Decode the level first
        try:
            level_data = level_encoder.decode(encoded_level)
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to decode level: {str(e)}",
            }

        tiles = level_data["tiles"]
        if not isinstance(tiles, list) or not tiles:
            return {"success": False, "error": "Invalid tiles array"}

        height = len(tiles)
        width = len(tiles[0]) if tiles else 0

        # Validate coordinates
        if row < 0 or row >= height:
            return {
                "success": False,
                "error": f"Invalid row {row} - must be 0-{height-1}",
            }

        if col < 0 or col >= width:
            return {
                "success": False,
                "error": f"Invalid column {col} - must be 0-{width-1}",
            }

        # Validate tile type
        if new_tile_type < 0 or new_tile_type > 7:
            return {
                "success": False,
                "error": f"Invalid tile type {new_tile_type} - must be 0-7",
            }

        # Make the edit
        old_tile_type = tiles[row][col]
        tiles[row][col] = new_tile_type

        # Create new level data
        edited_level = level_data.copy()
        edited_level["tiles"] = tiles

        # Generate encoded version
        try:
            encoded_level = level_encoder.encode(edited_level)
            play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"
        except Exception as e:
            logger.warning(f"Failed to encode edited level: {e}")
            encoded_level = None
            play_url = None

        # Generate visualization
        visualization = visualize_level(edited_level)

        old_tile_name = TILE_TYPES.get(old_tile_type, {"name": "Unknown"})["name"]
        new_tile_name = TILE_TYPES.get(new_tile_type, {"name": "Unknown"})["name"]

        return {
            "success": True,
            "level_data": edited_level,
            "encoded_level": encoded_level,
            "play_url": play_url,
            "visualization": visualization,
            "change_summary": f"Changed tile at ({row}, {col}) from {old_tile_name} to {new_tile_name}",
            "message": f"Successfully edited tile at position ({row}, {col})",
        }

    except Exception as e:
        logger.error(f"Failed to edit level tile: {e}")
        return {"success": False, "error": f"Failed to edit level tile: {str(e)}"}


@mcp.tool()
async def edit_level_row(
    encoded_level: str, row: int, new_row_tiles: List[int]
) -> Dict[str, Any]:
    """Edit an entire row in a VibeTide level.

    Args:
        encoded_level: An encoded level string from a URL or sharing link
        row: Row index to replace (0-based, from top)
        new_row_tiles: Array of tile types for the new row (each 0-7)

    Returns the modified level data with the entire row replaced.
    """
    try:
        # Decode the level first
        try:
            level_data = level_encoder.decode(encoded_level)
        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to decode level: {str(e)}",
            }

        tiles = level_data["tiles"]
        if not isinstance(tiles, list) or not tiles:
            return {"success": False, "error": "Invalid tiles array"}

        height = len(tiles)
        width = len(tiles[0]) if tiles else 0

        # Validate row index
        if row < 0 or row >= height:
            return {
                "success": False,
                "error": f"Invalid row {row} - must be 0-{height-1}",
            }

        # Validate new row tiles
        if not isinstance(new_row_tiles, list):
            return {"success": False, "error": "new_row_tiles must be a list"}

        if len(new_row_tiles) != width:
            return {
                "success": False,
                "error": f"new_row_tiles length {len(new_row_tiles)} doesn't match level width {width}",
            }

        # Validate tile types
        for i, tile_type in enumerate(new_row_tiles):
            if not isinstance(tile_type, int) or tile_type < 0 or tile_type > 7:
                return {
                    "success": False,
                    "error": f"Invalid tile type {tile_type} at position {i} - must be integer 0-7",
                }

        # Make the edit
        old_row = tiles[row].copy()
        tiles[row] = new_row_tiles.copy()

        # Create new level data
        edited_level = level_data.copy()
        edited_level["tiles"] = tiles

        # Generate encoded version
        try:
            encoded_level = level_encoder.encode(edited_level)
            play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"
        except Exception as e:
            logger.warning(f"Failed to encode edited level: {e}")
            encoded_level = None
            play_url = None

        # Generate visualization
        visualization = visualize_level(edited_level)

        return {
            "success": True,
            "level_data": edited_level,
            "encoded_level": encoded_level,
            "play_url": play_url,
            "visualization": visualization,
            "change_summary": f"Replaced row {row}: {old_row} → {new_row_tiles}",
            "message": f"Successfully edited row {row}",
        }

    except Exception as e:
        logger.error(f"Failed to edit level row: {e}")
        return {"success": False, "error": f"Failed to edit level row: {str(e)}"}


@mcp.tool()
async def edit_entire_level(
    level_data: Dict[str, Any],
    new_tiles: List[List[int]],
    new_name: Optional[str] = None,
    new_description: Optional[str] = None,
    max_enemies: Optional[int] = None,
    enemy_spawn_chance: Optional[float] = None,
    coin_spawn_chance: Optional[float] = None,
) -> Dict[str, Any]:
    """Edit an entire VibeTide level, replacing all tiles and optionally metadata.

    Args:
        level_data: The original level data (for reference)
        new_tiles: 2D array of tile types (each 0-7)
        new_name: New name for the level (optional)
        new_description: New description for the level (optional)
        max_enemies: Maximum enemies parameter (1-10, optional)
        enemy_spawn_chance: Enemy spawn chance percentage (0-100, optional)
        coin_spawn_chance: Coin spawn chance percentage (0-100, optional)

    Returns the completely modified level data.
    """
    try:
        # Validate new tiles array
        if not isinstance(new_tiles, list) or not new_tiles:
            return {"success": False, "error": "new_tiles must be a non-empty 2D array"}

        # Validate dimensions
        height = len(new_tiles)
        width = len(new_tiles[0]) if new_tiles else 0

        if width == 0:
            return {"success": False, "error": "new_tiles rows cannot be empty"}

        # Validate all rows have same width and contain valid tile types
        for row_idx, row in enumerate(new_tiles):
            if not isinstance(row, list):
                return {"success": False, "error": f"Row {row_idx} is not a list"}

            if len(row) != width:
                return {
                    "success": False,
                    "error": f"Row {row_idx} has length {len(row)}, expected {width}",
                }

            for col_idx, tile_type in enumerate(row):
                if not isinstance(tile_type, int) or tile_type < 0 or tile_type > 7:
                    return {
                        "success": False,
                        "error": f"Invalid tile type {tile_type} at ({row_idx}, {col_idx}) - must be integer 0-7",
                    }

        # Create new level data
        edited_level = {
            "tiles": [row.copy() for row in new_tiles],
            "width": width,
            "height": height,
            "name": new_name or level_data.get("name", "Edited Level"),
            "description": new_description
            or level_data.get("description", "A custom edited level"),
        }

        # Add game parameters if provided
        if max_enemies is not None:
            if not isinstance(max_enemies, int) or max_enemies < 0 or max_enemies > 10:
                return {"success": False, "error": "max_enemies must be integer 0-10"}
            edited_level["maxEnemies"] = max_enemies
        elif "maxEnemies" in level_data:
            edited_level["maxEnemies"] = level_data["maxEnemies"]

        if enemy_spawn_chance is not None:
            if (
                not isinstance(enemy_spawn_chance, (int, float))
                or enemy_spawn_chance < 0
                or enemy_spawn_chance > 100
            ):
                return {
                    "success": False,
                    "error": "enemy_spawn_chance must be number 0-100",
                }
            edited_level["enemySpawnChance"] = float(enemy_spawn_chance)
        elif "enemySpawnChance" in level_data:
            edited_level["enemySpawnChance"] = level_data["enemySpawnChance"]

        if coin_spawn_chance is not None:
            if (
                not isinstance(coin_spawn_chance, (int, float))
                or coin_spawn_chance < 0
                or coin_spawn_chance > 100
            ):
                return {
                    "success": False,
                    "error": "coin_spawn_chance must be number 0-100",
                }
            edited_level["coinSpawnChance"] = float(coin_spawn_chance)
        elif "coinSpawnChance" in level_data:
            edited_level["coinSpawnChance"] = level_data["coinSpawnChance"]

        # Generate encoded version
        try:
            encoded_level = level_encoder.encode(edited_level)
            play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"
        except Exception as e:
            logger.warning(f"Failed to encode edited level: {e}")
            encoded_level = None
            play_url = None

        # Generate visualization
        visualization = visualize_level(edited_level)

        return {
            "success": True,
            "level_data": edited_level,
            "encoded_level": encoded_level,
            "play_url": play_url,
            "visualization": visualization,
            "change_summary": f"Replaced entire level: {width}x{height} tiles",
            "message": f"Successfully edited entire level '{edited_level['name']}'",
        }

    except Exception as e:
        logger.error(f"Failed to edit entire level: {e}")
        return {"success": False, "error": f"Failed to edit entire level: {str(e)}"}


@mcp.tool()
async def create_level(
    level_name: str,
    description: str,
    tiles: List[List[int]],
    width: int = 50,
    height: int = 22,
    maxEnemies: int = 5,
    enemySpawnChance: float = 10.0,
    coinSpawnChance: float = 15.0,
) -> Dict[str, Any]:
    """You are an AI assistant tasked with creating fast, fun, and playable levels for the VibeTide 2D platformer game. Your role is to design levels that are engaging and balanced while adhering to specific rules and guidelines.

    Here are the critical rules you must follow:
    1. Create levels that are EXACTLY target_width tiles wide and target_height tiles tall (default 50×22).
    2. The player must spawn at the LEFTMOST solid platform in the bottom half of the level.
    3. Leave 3-4 empty rows above the starting platform for jumping.
    4. Design the level as a LEFT-TO-RIGHT platformer, not a maze.

    Use the following tile types in your level design:
    0 = Empty
    1 = Grass
    2 = Rock
    3 = Yellow
    4 = Ice
    5 = Red
    6 = Spikes
    7 = Water

    Follow these level design guidelines:
    - Bottom half: Focus on main platforms and gameplay elements
    - Top half: Keep mostly empty for air and jumping
    - Create jumpable gaps (maximum 3-4 tiles apart)
    - Ensure a clear left-to-right progression

    For difficulty parameters:
    - Easy levels: maxEnemies=2-3, enemySpawnChance=5-10, coinSpawnChance=20-30
    - Medium levels: maxEnemies=4-6, enemySpawnChance=10-15, coinSpawnChance=15-20
    - Hard levels: maxEnemies=7-10, enemySpawnChance=15-25, coinSpawnChance=10-15


    Ensure that your level is exactly the specified dimensions and follows all the design rules for playability.

    Args:
        level_name: The name of the level
        description: A brief description of the level
        tiles: A 2D array of tile types
        width: The width of the level
        height: The height of the level
        maxEnemies: The maximum number of enemies in the level
        enemySpawnChance: The chance of an enemy spawning
        coinSpawnChance: The chance of a coin spawning
    """
    try:

        # Create the level data dictionary
        level_data = {
            "name": level_name,
            "description": description,
            "tiles": tiles,
            "width": width,
            "height": height,
            "maxEnemies": maxEnemies,
            "enemySpawnChance": enemySpawnChance,
            "coinSpawnChance": coinSpawnChance,
        }

        # Pass the complete level_data dictionary to the encoder
        encoded_level = level_encoder.encode(level_data)
        play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"

        return {
            "success": True,
            "level_data": level_data,
            "encoded_level": encoded_level,
            "play_url": play_url,
            "message": f"Successfully created level '{level_name}'",
        }

    except Exception as e:
        logger.error(f"Failed to create level with AI: {e}")
        return {"success": False, "error": f"Failed to create level with AI: {str(e)}"}


@mcp.tool()
async def decode_level_from_url(encoded_level: str) -> Dict[str, Any]:
    """Decode a VibeTide level from an encoded URL string.

    Args:
        encoded_level: The encoded level string from a URL or sharing link

    Returns the decoded level data with visualization.
    """
    try:
        level_data = level_encoder.decode(encoded_level)
        visualization = visualize_level(level_data)
        play_url = f"{VIBE_TIDE_CONFIG['web_player_url']}?level={encoded_level}"

        return {
            "success": True,
            "level_data": level_data,
            "visualization": visualization,
            "play_url": play_url,
            "encoded_level": encoded_level,
            "message": f"Successfully decoded level: {level_data.get('name', 'Unnamed Level')}",
        }

    except Exception as e:
        logger.error(f"Failed to decode level: {e}")
        return {"success": False, "error": f"Failed to decode level: {str(e)}"}


@mcp.tool()
async def get_tile_reference() -> Dict[str, Any]:
    """Get the reference guide for VibeTide tile types.

    Returns information about all available tile types and their properties.
    """
    return {
        "success": True,
        "tile_types": TILE_TYPES,
        "message": "VibeTide Tile Reference Guide",
        "usage_notes": [
            "Tile types are represented by integers 0-7",
            "Use these numbers when editing levels",
            "Empty tiles (0) represent walkable air space",
            "Platform tiles (1-3) are solid ground",
            "Special tiles (4-7) have unique properties",
        ],
    }


def main():
    """Main entry point for the VibeTide MCP Server"""
    logger.info("Starting VibeTide MCP Server...")
    logger.info(f"Web Player URL: {VIBE_TIDE_CONFIG['web_player_url']}")
    logger.info("Available tools:")
    logger.info("  - view_level: View level with ASCII visualization")
    logger.info("  - view_level_image: View level as beautiful PNG image")
    logger.info("  - play_level: Get URL to play level")
    logger.info("  - edit_level_tile: Edit single tile")
    logger.info("  - edit_level_row: Edit entire row")
    logger.info("  - edit_entire_level: Edit complete level")
    logger.info("  - create_level: Use AI to create/modify levels")
    logger.info("  - decode_level_from_url: Decode level from URL")
    logger.info("  - get_tile_reference: Get tile type reference")
    logger.info("")
    logger.info("Note: Use view_level_image for much better visuals!")
    logger.info("      AI level generation uses VibeTide agent prompts in docstrings")
    logger.info("      for MCP client integration")

    mcp.run()


# Run the server when the script is executed directly
if __name__ == "__main__":
    main()
