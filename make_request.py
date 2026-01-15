from typing import Final

from argparse import ArgumentParser
from urllib.request import Request, urlopen


#: Default URL to call the service on (including port).
url: Final[str] = 'http://localhost:8078'

#: The delimiter to use between output sections (so you can clearly see where one section ends).
section_separator: Final[str] = "\n----------\n"


def request(url: str, input_data_filename:str) -> None:
    with open(input_data_filename, "r") as input_file:
        input = input_file.read()

    print("Request:")
    print(input, section_separator)

    headers = {"content-type": "application/json"}
    request = Request(url, data=input.encode(), headers=headers)
    with urlopen(request) as response:
        print("Response Headers: ")
        print(response.headers, section_separator)

        print("Response Data:")
        print(response.read().decode(), section_separator)


if __name__ == "__main__":
    parser = ArgumentParser(description="Makes a HTTP Post request to a service showing input and result.")

    parser.add_argument("url", nargs="?", help="URL of the service to call including port number. Example: " + url)
    parser.add_argument("input_data_filename", nargs="?", help="Filename of the file containing input data to use when making the request.")
    args = parser.parse_args()

    request(args.url or url, args.input_data_filename or "tests/request.json")
