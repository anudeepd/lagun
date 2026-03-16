<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/logo.svg" alt="Lagun" width="120"/>
</p>

<h1 align="center">Lagun</h1>

<p align="center">A minimal, web-based MySQL/MariaDB GUI editor. Install it, run it, use it.</p>

## Features

- **Web-based SQL editor** with syntax highlighting, autocompletion, and multi-tab support
- **Schema browser** — explore databases, tables, columns, and indexes
- **Schema management** — create, modify, and drop tables, columns, and indexes
- **In-line data editing** — edit cells, insert rows, delete rows directly in the grid
- **Import & export** — CSV and SQL formats with streaming for large datasets
- **Query history** — track past queries with execution time and row counts
- **Bookmarks** — save and organize frequently used tables
- **Connection management** — import and export connection configs
- **Secure connections** — SSL/TLS, credentials stored in OS keyring, encrypted session backup

## Install

```bash
pip install lagun
```

## Usage

```bash
lagun serve
```

Opens the GUI in your browser. Connect to any MySQL or MariaDB database from there.

Options:

```
--host TEXT     Bind host. [default: 127.0.0.1]
--port INTEGER  Bind port. [default: 8080]
--no-open       Don't open the browser automatically.
```

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_1.png" alt="SQL Editor" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_2.png" alt="Schema View" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_3.png" alt="Data View with Search" width="100%"/>
  <img src="https://raw.githubusercontent.com/anudeepd/lagun/main/assets/img_4.png" alt="Data View with Filter" width="100%"/>
</p>

## Development

Requires [uv](https://github.com/astral-sh/uv).

```bash
git clone https://github.com/anudeepd/lagun
cd lagun
uv sync
uv run lagun serve
```

## License

MIT
