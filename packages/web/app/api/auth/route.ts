import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { password } = await request.json();

    const correctPassword = process.env.AUTH_PASSWORD;

    if (!correctPassword) {
      return NextResponse.json(
        { authenticated: false, error: 'Authentication not configured' },
        { status: 500 }
      );
    }

    if (password === correctPassword) {
      return NextResponse.json({ authenticated: true });
    }

    return NextResponse.json(
      { authenticated: false, error: 'Invalid password' },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json(
      { authenticated: false, error: 'Invalid request' },
      { status: 400 }
    );
  }
}
