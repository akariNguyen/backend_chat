"""Fetch public web resources without letting a URL reach private networks.

The page URL comes from the user and the logo URLs come from a model that read
untrusted pages, so every request (and every redirect hop) is checked first:
http/https only, port 80/443, no credentials, and every resolved IP must be public.
"""
import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import httpx

# Many sites (and upload.wikimedia.org) answer 403 to bot-like clients, so send ordinary browser headers.
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/svg+xml,image/*;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
}


class UnsafeURL(ValueError):
    """The URL must not be fetched."""


class NotPublicAddress(UnsafeURL):
    """The host resolves to a private, loopback or otherwise non-public address."""


class UnresolvableHost(UnsafeURL):
    """DNS has no address for the host (dead or not yet registered domain)."""


def check_url_syntax(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURL("Chỉ hỗ trợ URL http/https")
    if not parts.hostname:
        raise UnsafeURL("URL không có tên miền")
    if parts.username or parts.password:
        raise UnsafeURL("Không hỗ trợ URL chứa thông tin đăng nhập")
    try:
        port = parts.port
    except ValueError as exc:
        raise UnsafeURL("Cổng không hợp lệ") from exc
    if port not in (None, 80, 443):
        raise UnsafeURL("Chỉ hỗ trợ cổng 80 hoặc 443")


async def check_public_url(url: str) -> None:
    check_url_syntax(url)
    parts = urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnresolvableHost(f"Không phân giải được tên miền {parts.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise NotPublicAddress(f"{parts.hostname} trỏ tới địa chỉ không công khai ({ip})")


async def safe_get(client: httpx.AsyncClient, url: str, *, max_bytes: int, timeout: float = 20.0,
                   max_hops: int = 5) -> tuple[str, str, bytes]:
    """GET with every redirect hop checked before it is requested -> (final URL, content-type, body)."""
    target = url
    for _ in range(max_hops + 1):
        await check_public_url(target)
        async with client.stream("GET", target, follow_redirects=False, timeout=timeout,
                                 headers=HEADERS) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("Redirect không có Location")
                target = urljoin(target, location)
                continue
            response.raise_for_status()
            chunks, size = [], 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError(f"Lớn hơn {max_bytes // 1024} KB")
                chunks.append(chunk)
            return str(response.url), response.headers.get("content-type", ""), b"".join(chunks)
    raise ValueError("Quá nhiều lần redirect")
