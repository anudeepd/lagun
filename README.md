<p align="center">
  <img src="assets/logo.svg" alt="Lagun" width="120"/>
</p>

<h1 align="center">Lagun</h1>

<p align="center">A minimal, web-based MySQL/MariaDB GUI editor. Install it, run it, use it.</p>

## Install

```bash
pip install git+https://github.com/anudeepd/lagun
```

## Usage

```bash
lagun serve
```

Opens the GUI in your browser. Connect to any MySQL or MariaDB database from there.

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
