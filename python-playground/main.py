"""A tiny runnable example for quick Python experiments."""


def greet(name: str) -> str:
    return f"Hello, {name}! Your Python playground is ready."


def main() -> None:
    print(greet("Replit"))


if __name__ == "__main__":
    main()