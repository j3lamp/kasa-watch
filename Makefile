# Be sure to specify a value for the dockerReporitory variable when running
# make.

OUT := @
ifdef VERBOSE
  OUT :=
endif


DOCKER := docker

ANSI_red     := 31
ANSI_green   := 32
ANSI_yellow  := 33
ANSI_blue    := 34
ANSI_magenta := 35
ANSI_cyan    := 36
define cprint
  @printf "\033[$(ANSI_$(1))m"$(2)"\033[0m\n"
endef

generateColor := cyan
buildColor    := blue
runColor      := green
otherColor    := magenta


arch             := $(shell uname -m)
version          := $(shell git describe --dirty --match "version/*" | sed -e 's|^version/||')
dockerRepository :=
dockerName       := $(dockerRepository)/kasa-watch:$(version)_$(arch)

.PHONY: all
all: docker
	$(OUT) :

docker: index.js package.json package-lock.json Dockerfile
	$(call cprint,$(buildColor),"Building Docker image $(dockerName)")
	$(OUT) $(DOCKER) build . --tag $(dockerName)
