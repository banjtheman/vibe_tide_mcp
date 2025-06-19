# VibeTide MCP Server

A Model Context Protocol (MCP) server for creating, editing, and playing VibeTide 2D platformer levels. This server provides tools for level manipulation, visualization, and gameplay through the MCP protocol.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

## Features

- **Level Creation**: Create new VibeTide levels with AI assistance
- **Level Editing**: Edit entire levels, single rows, or individual tiles
- **Level Visualization**: Generate ASCII and PNG visualizations of levels
- **Level Playing**: Get URLs to play levels in the web player
- **Level Decoding**: Decode levels from sharing URLs
- **Metadata Management**: Edit level properties like spawn rates and difficulty

## Installation

### Option 1: Using UVX (Recommended)

If you have `uvx` installed, you can run the server directly without local installation:

```bash
uvx --from vibe-tide-mcp-server vibe-tide-mcp-server
```

### Option 2: Local Installation

1. Clone the repository:
```bash
git clone https://github.com/banjtheman/vibe_tide_mcp.git
cd vibe_tide_mcp
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Make the server executable:
```bash
chmod +x vibe_tide_mcp_server.py
```

## Configuration

### MCP Client Configuration

Add the server to your MCP client configuration:

#### Local Python Server
```json
{
  "mcpServers": {
    "vibe-tide": {
      "command": "python",
      "args": ["/path/to/vibe_tide_mcp_server.py"],
      "env": {}
    }
  }
}
```

#### Using UVX
```json
{
  "mcpServers": {
    "vibe-tide": {
      "command": "uvx",
      "args": [
        "--from", "vibe-tide-mcp-server", "vibe-tide-mcp-server"
      ],
      "env": {}
    }
  }
}
```

## Available Tools

### Level Viewing Tools
- **view_level**: View level data with ASCII visualization
- **view_level_image**: Generate beautiful PNG visualizations
- **decode_level_from_url**: Decode levels from sharing URLs
- **get_tile_reference**: Get reference guide for tile types

### Level Playing Tools
- **play_level**: Get URL to play level in web player

### Level Editing Tools
- **edit_level_tile**: Edit a single tile
- **edit_level_row**: Edit an entire row
- **edit_entire_level**: Replace all tiles in a level
- **edit_level_metadata**: Edit level properties (name, spawn rates, etc.)

### Level Creation Tools
- **create_level**: Create new levels with AI assistance

## Tile Types

| Type | Symbol | Name | Description |
|------|---------|------|-------------|
| 0 | ⬜ | Empty | Walkable air space |
| 1 | 🌱 | Grass | Standard ground platform |
| 2 | 🗿 | Rock | Solid stone platform |
| 3 | ⭐ | Yellow | Special yellow platform |
| 4 | ❄️ | Ice | Slippery ice platform |
| 5 | 🔥 | Red | Dangerous red platform |
| 6 | ⚠️ | Spikes | Hazardous spikes |
| 7 | 💧 | Water | Water tiles |

## Examples

### Creating a New Level

```python
# Create a simple level with platforms
level_tiles = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  # Empty top row
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],  # Empty row
    [0, 0, 0, 1, 1, 1, 0, 0, 0, 0],  # Grass platform
    [1, 1, 0, 0, 0, 0, 0, 1, 1, 1],  # Ground platforms
    [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],  # Rock foundation
]

result = create_level(
    level_name="My First Level",
    description="A simple starter level",
    tiles=level_tiles,
    width=10,
    height=5,
    maxEnemies=3,
    enemySpawnChance=10.0,
    coinSpawnChance=20.0
)
```

### Editing a Level

```python
# Edit a single tile
result = edit_level_tile(
    encoded_level="your_encoded_level_here",
    row=2,
    col=5,
    new_tile_type=6  # Add spikes
)

# Edit level metadata
result = edit_level_metadata(
    encoded_level="your_encoded_level_here",
    new_name="Updated Level",
    max_enemies=5,
    enemy_spawn_chance=15.0
)
```

### Viewing and Playing Levels

```python
# View level visualization
result = view_level("your_encoded_level_here")
print(result["visualization"])

# Generate PNG image
image_path = view_level_image("your_encoded_level_here")

# Get play URL
result = play_level("your_encoded_level_here")
print(f"Play at: {result['play_url']}")
```

## Development

### Running the Server

```bash
python vibe_tide_mcp_server.py
```

### Testing

The server includes comprehensive error handling and validation for all level operations.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [VibeTide Player](https://vibetideplayer.banjtheman.xyz/) - Web player for VibeTide levels
- [Model Context Protocol](https://modelcontextprotocol.io/) - Learn more about MCP

## Support

- [GitHub Issues](https://github.com/banjtheman/vibe_tide_mcp/issues)
- [VibeTide Community](https://vibetide.com)
