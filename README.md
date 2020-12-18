# kasa-watch

A simple tool, written in JavaScript, for polling
[TP-Link Kasa](https://www.kasasmart.com/) switches and updating
[Home Assistant](https://www.home-assistant.io/) binary sensors when switch
states change.

While TP-Link has its own cloud platform one of the nice thing about their Kasa
smart home switches and outlets is that they can be controlled entirely on your
local network using tools like Home Assistant. While Home Assistant can control
these Kasa devices quite well it only updates their state every 30 seconds. This
means you can't use HomeAssistant automations to turn 3 Kasa switches into 4-way
switches.

Using `kasa-watch` you can update a binary sensor in HomeAssistant at a much
higher frequency, say every second, whenever a switches state changes. For the
example above whenever one of the three switches state changes the Home
Assistant binary variable. Then Home Assistant can handle the appropriate
automation when the binary variable's state changes.

*Note:* Whenever a group of switches is used to update one binary variable in
 Home Assistant be sure to have Home Assistant update the states of all the
 switches to match, `kasa-watch` does not do this.

## Use

To create and update the binary senor in Home Assistant you need a long-lived
access token. One can be created in your
Home Assistant [Account Profile](https://www.home-assistant.io/docs/authentication/#your-account-profile)
or via its
[authentication API](https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token).

Once you have the token put it in a text file that nobody else can read, let's
call it `ha.token`. Then create a JSON configuration file (see below), which
we'll call `kw-config.json`. Now simply run it with:

`node index.js --ha-token-file ha.token --configuration kw-config.json`

## Configuration

The configuration is a [JSON](https://www.json.org/) file containing an object
with the following keys:

- `home_assistant_url` (string) **required** -
  The URL to your Home Assistant server.

- `poll_interval_ms` (number) **required** -
  The interval at which to poll the Kasa switches, in milliseconds.

- `kasa_timeout_ms` (number) *optional* -
  How long to wait for a response from the Kasa switches, in milliseconds.
  Defaults to `100000`, or 10 seconds.

- `binary_sensors` (object) **required** -
  Each key in this object is the name of a HomeAssistant binary sensor. The
  values are objects with the following keys:

  - `hosts` (array of strings) **required** -
    Each element in the array should be a string containing the IP address or
    domain name of a Kasa switch.

  - `default_state` (string) **required** -
    Either one of "on" or "off". The state to use on startup if an equal number
    of the switches listed in the `hosts` array report "on" and "off" as their
    state. This is simply a tie-breaker.

### Example

```.json
{
    "home_assistant_url": "http://192.168.1.12",
    "poll_interval_ms":   1000,
    "kasa_timeout_ms":     250,
    "binary_sensors": {
        "study_lights": {
            "hosts": [
                "192.168.1.20",
                "192.168.1.21",
                "192.168.1.22"
            ],
            "default_state": "off"
        }
    }
}
```

In this example there is one binary sensor named `study_lights` whose state is
set by polling the three Kasa switches at `192.168.1.20`, `192.168.1.21`, and
`192.168.1.22` every second. If a response is not received from a switch within
250 milliseconds this is logged and it will be attempted the next time all the
switches are polled.

### Notes

- If `poll_interval_ms` is too small and multiple switches are used for one
  binary sensor Home Assistant may not have enough time to update the other
  switches before the next time they are polled. In this situation the binary
  sensor value will quickly oscillate between "on" and "off" yielding highly
  undesirable results and flickering lights.

- While optional, `kasa_timeout_ms` should be set to a time less than
  `poll_interval_ms`.

- If you Home Assistant instance is accessed via HTTPS be sure to provide the
  necessary root certificate to [node.js](https://nodejs.org/) using the
  [`NODE_EXTRA_CA_CERTS`](https://nodejs.org/api/cli.html#cli_node_extra_ca_certs_file)
  environment variable.

## Docker

The included [Dockerfile](https://docs.docker.com/engine/reference/builder/) can
be used to create a [Docker](https://www.docker.com/) container that runs
`kasa-watch`. Alternatively the included Makefile will build and tag the
container image, but you do need to provide it the repository to use for the
tag.

- Using docker: `docker build .`

  This will create the image but not tag it, you will have to do that as a
  separate step.

- Example using `make`: `make dockerRepository=j3lamp`

  This will create the docker image and tag it as
  `j3lamp/kasa-watch:<version>_<architecture>`. The version will be filled in
  using `git describe` and the architecture using `uname -m`. For example:
  `j3lamp/kasa-watch:1.0_x86_64`.

Assuming the Docker image was built and tagged as in the example above you could
run a container with the following command:

`docker run --volume ${PWD}/ha.token:/ha.token --volume ${PWD}/kw-config.json:/kw-config.json j3lamp/kasa-watch:1.0_x86_64 --ha-token-file ha.token --configuration kw-config.json`

If you need to provide a custom root certificate use the following command:

`docker run --volume ${PWD}/root.crt:/root.crt --env NODE_EXTRA_CA_CERTS=/root.crt --volume ${PWD}/ha.token:/ha.token --volume ${PWD}/kw-config.json:/kw-config.json j3lamp/kasa-watch:1.0_x86_64 --ha-token-file ha.token --configuration kw-config.json`

## Supported Node.js Versions

Currently this has only been tested with 14.15.1.
