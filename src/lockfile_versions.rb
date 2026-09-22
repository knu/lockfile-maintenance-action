# frozen_string_literal: true

require "bundler"
require "json"

def main
  specs = Bundler::LockfileParser.new($stdin.read).specs
  puts JSON.generate(specs.map { |spec| [spec.name, spec.version.to_s] })
end

main
