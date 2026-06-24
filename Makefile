# Makefile for StarMade Map Plugin

.PHONY: all build build-frontend build-backend test clean help

# Configuration variables
FRONTEND_DIR ?= frontend
BACKEND_BUILD_DIR ?= build
WEB_RESOURCES_DIR ?= src/main/resources/web

# Commands
NPM ?= npm
GRADLE ?= $(shell if [ -f ./gradlew ]; then echo "./gradlew"; else echo "gradle"; fi)

# Default target: build both parts
all: build

# Build both frontend and backend
build: build-frontend build-backend

# Build the frontend Vite application
build-frontend:
	@echo "Building frontend..."
	cd $(FRONTEND_DIR) && $(NPM) install && $(NPM) run build

# Build the backend Java plugin jar
build-backend:
	@echo "Building backend mod jar..."
	$(GRADLE) shadowJar

# Run JVM unit tests
test:
	@echo "Running JUnit tests..."
	$(GRADLE) test

# Clean up build outputs
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(BACKEND_BUILD_DIR)
	if [ -d "$(WEB_RESOURCES_DIR)" ]; then rm -rf $(WEB_RESOURCES_DIR)/*; fi
	if [ -d "$(FRONTEND_DIR)" ]; then cd $(FRONTEND_DIR) && rm -rf dist node_modules; fi

# Help screen
help:
	@echo "StarMade Map Plugin Build Automation Utility"
	@echo "============================================="
	@echo "Available commands:"
	@echo "  make build           - Compiles and bundles both frontend and backend"
	@echo "  make build-frontend  - Installs npm packages and builds Vite assets"
	@echo "  make build-backend   - Compiles Java backend and creates shadowed plugin JAR"
	@echo "  make test            - Runs JVM unit tests (JUnit 5)"
	@echo "  make clean           - Removes build directories and temporary assets"
