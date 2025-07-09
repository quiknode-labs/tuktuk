# TukTuk Documentation Site

This is the official documentation website for TukTuk, a permissionless crank service for Solana that allows you to schedule automated tasks and transactions.

## Getting Started

### Prerequisites

- Node.js 20+

### Installation

```bash
npm install
```

### Development

To start the development server:

```bash
npm run dev
```

The site will be available at `http://localhost:3000`.

### Building for Production

```bash
npm run build
npm start
```

## Project Structure

```
docsite/
├── src/
│   ├── components/          # React components
│   ├── pages/              # Next.js pages
│   │   ├── docs/           # Documentation pages
│   │   │   ├── api/        # API documentation
│   │   │   ├── learn/      # Learning guides
│   │   │   └── overview.md # Overview page
│   │   └── index.jsx       # Homepage
│   ├── markdoc/            # Markdoc configuration
│   └── styles/             # CSS styles
├── public/                 # Static assets
└── scripts/                # Build scripts
```

## Documentation

The documentation is written in Markdown and uses [Markdoc](https://markdoc.dev/) for enhanced formatting and components.

### Adding Documentation

1. Create a new `.md` file in the appropriate directory under `src/pages/docs/`
2. Add the page to the navigation in `src/data/navigation.js`
3. Use Markdoc syntax for enhanced components like callouts and code blocks

### API Documentation

API documentation is auto-generated from IDL files. To regenerate:

```bash
npm run generate-idl-docs
```

## Features

- **Search**: Powered by Algolia autocomplete
- **Responsive Design**: Mobile-friendly interface
- **Syntax Highlighting**: Code blocks with Prism.js
- **Component Library**: Reusable UI components
- **Dark Mode**: (if implemented)

## Technology Stack

- **Framework**: Next.js 13
- **Documentation**: Markdoc
- **Styling**: Tailwind CSS
- **Search**: Algolia
- **Deployment**: (Add deployment info)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `npm run dev`
5. Submit a pull request

## License

See [LICENSE.md](LICENSE.md) for details.