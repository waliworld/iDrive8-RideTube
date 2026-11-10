# ytdec: the video half of RideTube. README.md.
#
#   make test     host build + tests: NAL reader (from waze-on-cluster), index,
#                 MGVF writer, pacing/seek/tail/eof on a fake decoder
#   make target   head-unit binary build/target/ytdec, built in Docker with
#                 the toolchain image in docker/ (Ubuntu 18.04: gcc 7.5,
#                 glibc 2.27), linked against stubs of the unit's libmfxhw64,
#                 libva and libva-drm, every import checked
#
# On macOS, Docker cannot mount /var/folders: point TMPDIR at a folder it can
# mount first.

CXX     ?= c++
PYTHON  ?= python3
BUILD   ?= build
IMAGE   := ytdec-build:$(shell cksum 2>/dev/null < docker/Dockerfile | cut -d' ' -f1)
DOCKER_IMAGE = docker image inspect $(IMAGE) >/dev/null 2>&1 || \
	docker build -q --platform linux/amd64 -t $(IMAGE) docker
VERSION := $(shell git describe --always --dirty 2>/dev/null || echo dev)

CXXFLAGS = -std=c++14 -O2 -g -Wall -Wextra -Werror
CPPFLAGS = -Isrc -Iabi/include
T = $(BUILD)/target

HOST_SRC = src/player.cpp src/index.cpp src/mgvf.cpp
SRC = src/main.cpp src/decoder_msdk.cpp src/nal_reader.cpp $(HOST_SRC)
HDR = $(wildcard src/*.h)

.PHONY: all test target target-in-docker clean
all: test

test: $(BUILD)/host/nal_reader_test $(BUILD)/host/player_test
	$(BUILD)/host/nal_reader_test
	$(BUILD)/host/player_test

$(BUILD)/host/nal_reader_test: test/nal_reader_test.cpp src/nal_reader.cpp src/nal_reader.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/nal_reader_test.cpp src/nal_reader.cpp

$(BUILD)/host/player_test: test/player_test.cpp $(HOST_SRC) $(HDR)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ test/player_test.cpp $(HOST_SRC)

target:
	$(DOCKER_IMAGE)
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w" -w /w $(IMAGE) \
		make -s BUILD=$(BUILD) VERSION=$(VERSION) IMAGE=- target-in-docker

target-in-docker: $(T)/ytdec

$(T)/stub/libmfxhw64.so: abi/libmfx.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	gcc -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c

$(T)/stub/libva.so.1: abi/libva.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	gcc -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c

$(T)/stub/libva-drm.so.1: abi/libva-drm.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	gcc -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

STUBS = $(T)/stub/libmfxhw64.so $(T)/stub/libva.so.1 $(T)/stub/libva-drm.so.1

# -DNDEBUG: no assert may abort (and dump) on the unit
$(T)/ytdec: $(SRC) $(HDR) $(STUBS)
	mkdir -p $(@D)
	g++ $(CXXFLAGS) $(CPPFLAGS) -DNDEBUG -DYTDEC_VERSION='"$(VERSION)"' -pthread \
		-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -o $@ $(SRC) $(STUBS)
	$(PYTHON) tools/abi.py check $@ abi/libvsomeip3.so.3.symbols   # loader, glibc/libstdc++ limits
	$(PYTHON) tools/woc_abi.py check-imports $@ --prefix MFX va -- \
		abi/libmfx.symbols abi/libva.symbols abi/libva-drm.symbols

clean:
	rm -rf $(BUILD)
