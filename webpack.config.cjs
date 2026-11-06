const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  entry: {
    sidepanel: './src/sidepanel/index.tsx',
    background: './src/background/service-worker.ts',
    'content/chatgpt': './src/content/chatgpt.ts',
    'content/claude': './src/content/claude.ts',
    'content/gemini': './src/content/gemini.ts',
    'content/grok': './src/content/grok.ts',
    'content/meta': './src/content/meta.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader', 'postcss-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@sidepanel': path.resolve(__dirname, 'src/sidepanel'),
    },
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/sidepanel/index.html',
      filename: 'sidepanel.html',
      chunks: ['sidepanel'],
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'public', to: '.' },
      ],
    }),
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
  ],
  optimization: {
    splitChunks: false,
  },
};
